// server.js - Complete Express server with all 4 tabs
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const multer = require('multer');
const storyEngine = require('./story-engine');
const ffmpegUtils = require('./ffmpeg-utils');
const taskManager = require('./task-manager');
const { uploadImageToImgbb } = require('./image-host');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure upload directories exist
const UPLOAD_DIRS = ['uploads/videos', 'uploads/frames', 'uploads/output', 'uploads/temp'];
UPLOAD_DIRS.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ============================================================
// ACCESS KEY GATE
// Set APP_ACCESS_KEY in the environment to require every /api
// call (except /api/health) to send a matching x-app-key header
// (or ?key= query param). If APP_ACCESS_KEY is unset, the gate
// is disabled (local dev).
// This exists to stop strangers from hitting a public Railway URL
// and burning your Qwen/Pixazo credits.
//
// Two callers must present this key when the gate is enabled:
//   1. The browser frontend (public/app.js) — it reads the key
//      from ?key= on first load, caches it in localStorage, and
//      attaches it as x-app-key on every /api request.
//   2. story-engine.js's internal call to POST /api/generate-video
//      (it calls back into this same server over HTTP) — it reads
//      APP_ACCESS_KEY directly from process.env and attaches it
//      the same way.
// Without both of those, enabling this gate breaks the app.
// ============================================================
const APP_ACCESS_KEY = process.env.APP_ACCESS_KEY || '';

if (!APP_ACCESS_KEY) {
  console.warn('⚠️  APP_ACCESS_KEY is not set — /api routes are UNPROTECTED. Set APP_ACCESS_KEY before deploying publicly.');
}

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next(); // always allow health checks
  if (!APP_ACCESS_KEY) return next(); // gate disabled locally

  const provided = req.get('x-app-key') || req.query.key || '';
  if (provided && provided === APP_ACCESS_KEY) return next();

  return res.status(401).json({ error: 'Unauthorized. Missing or invalid access key.' });
});

// Initialize Qwen client
const qwenClient = new OpenAI({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: `https://${process.env.QWEN_WORKSPACE_ID}.${process.env.QWEN_REGION || 'ap-southeast-1'}.maas.aliyuncs.com/compatible-mode/v1`,
});
const QWEN_MODEL = 'qwen3-coder-flash';

// ============================================================
// MULTER CONFIGURATION FOR FILE UPLOADS
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads/temp'));
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: MP4, MOV, WebM, JPG, PNG, WebP`));
    }
  }
});

// ============================================================
// HEALTH & TEST ENDPOINTS
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    model: QWEN_MODEL,
  });
});

app.get('/api/test', (req, res) => {
  res.json({
    message: 'Server is running!',
    model: QWEN_MODEL,
    qwenBaseURL: qwenClient.baseURL,
    env: {
      qwen: !!process.env.QWEN_API_KEY,
      qwenWorkspaceId: !!process.env.QWEN_WORKSPACE_ID,
      qwenRegion: process.env.QWEN_REGION || 'ap-southeast-1 (default)',
      pixazo: !!process.env.PIXAZO_API_KEY,
      imgbb: !!process.env.IMGBB_API_KEY,
    },
  });
});

// ============================================================
// TAB 1: NEW STORY - STREAMING SPLIT
// ============================================================
app.post('/api/story/split-stream', async (req, res) => {
  try {
    const { style, script, numSegments, segmentDuration } = req.body;

    if (!style || style.trim().length < 10) {
      return res.status(400).json({ error: 'Style too short', message: 'Please provide at least 10 characters for the visual style.' });
    }

    if (!script || script.trim().length < 10) {
      return res.status(400).json({ error: 'Script too short', message: 'Please provide at least 10 characters.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const prompt = `You are creating a storyboard for an animated video.

VISUAL STYLE:
"${style}"

STORY:
"${script}"

Split this story into ${numSegments} scenes (each ~${segmentDuration}s).

IMPORTANT: Each scene prompt MUST include the visual style description to maintain consistency across all segments.

For each scene, provide a detailed video generation prompt that includes:
1. The visual style (from above)
2. Camera movement
3. Lighting and mood
4. Key visual elements and actions

Return ONLY valid JSON array: [{"prompt": "description with style included"}, ...]`;

    const stream = await qwenClient.chat.completions.create({
      model: QWEN_MODEL,
      messages: [
        { role: 'system', content: 'You are a storyboard expert. Return only valid JSON arrays. Each prompt must include the visual style for consistency.' },
        { role: 'user', content: prompt }
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.7,
      max_tokens: 3000,
    });

    let fullContent = '';
    let segments = [];

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const delta = chunk.choices[0].delta || {};
        if (delta.content) {
          fullContent += delta.content;

          try {
            const clean = fullContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            const match = clean.match(/\[[\s\S]*\]/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (Array.isArray(parsed) && parsed.length > 0) {
                segments = parsed;
                res.write(`data: ${JSON.stringify({ type: 'progress', segments, partial: true })}\n\n`);
              }
            }
          } catch (e) {
            // Not valid JSON yet
          }
        }
      }
    }

    try {
      const clean = fullContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) {
        segments = JSON.parse(match[0]);
      }
    } catch (e) {
      segments = Array(numSegments).fill(null).map((_, i) => ({
        prompt: `${style}. ${script} (part ${i + 1}/${numSegments})`
      }));
    }

    while (segments.length < numSegments) {
      segments.push({ prompt: `${style}. ${script} (part ${segments.length + 1})` });
    }
    segments = segments.slice(0, numSegments);

    res.write(`data: ${JSON.stringify({ type: 'complete', segments })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// ============================================================
// TAB 1: NEW STORY - GENERATE
// ============================================================
app.post('/api/story/generate', async (req, res) => {
  try {
    const { style, script, duration = 30, segmentDuration = 5, segments: providedSegments } = req.body;

    if (!script || script.trim().length < 10) {
      return res.status(400).json({ error: 'Script too short', message: 'Please provide at least 10 characters of script.' });
    }

    const taskId = uuidv4();
    const numSegments = Math.ceil(duration / segmentDuration);

    console.log(`\n📝 New story task: ${taskId}`);
    console.log(`   Style: "${style?.slice(0, 40)}..."`);
    console.log(`   Script: "${script.slice(0, 60)}..."`);
    console.log(`   Segments: ${numSegments} (${segmentDuration}s each)`);

    const segments = (providedSegments || []).map((s, i) => ({
      index: i,
      prompt: s.prompt,
      status: 'pending',
      videoPath: null,
      videoUrl: null,
      framePath: null,
      frameUrl: null,
      versions: [],
      error: null,
    }));

    const task = taskManager.createTask({
      id: taskId,
      type: 'new-story',
      metadata: {
        style: style?.trim() || '',
        script: script.trim(),
        duration,
        segmentDuration,
        totalSegments: numSegments,
      },
      segments,
    });

    // Start async processing
    setImmediate(() => {
      storyEngine.processStory(taskId, (update) => {
        // Updates are handled inside story-engine via taskManager
      });
    });

    const minTime = numSegments * 4;
    const maxTime = numSegments * 5;

    res.json({
      taskId,
      status: 'initialized',
      numSegments,
      estimatedTime: { min: minTime, max: maxTime },
      segments: task.segments,
    });
  } catch (error) {
    console.error('Error starting story:', error);
    res.status(500).json({ error: 'Failed to start story generation', message: error.message });
  }
});

// ============================================================
// TASK STATUS (shared across all tabs)
// ============================================================
app.get('/api/task/status/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = taskManager.getTask(taskId);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const totalSegments = task.segments.length;
  const completedSegments = task.segments.filter(s => s.status === 'completed').length;
  const progress = totalSegments > 0 ? completedSegments / totalSegments : 0;

  res.json({
    taskId: task.id,
    type: task.type,
    status: task.status,
    progress: Math.min(progress, 1),
    completedSegments,
    totalSegments,
    segments: task.segments.map(s => ({
      index: s.index,
      prompt: s.prompt,
      videoUrl: s.videoUrl,
      frameUrl: s.frameUrl,
      status: s.status,
      error: s.error || null,
    })),
    finalVideoUrl: task.finalVideoUrl,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
});

// ============================================================
// STOP GENERATION
// ============================================================
app.post('/api/task/stop/:taskId', (req, res) => {
  const { taskId } = req.params;
  const success = storyEngine.stopGeneration(taskId);

  if (success) {
    res.json({ success: true, message: 'Generation stopped' });
  } else {
    res.status(404).json({ error: 'Task not found' });
  }
});

// ============================================================
// RESUME A STOPPED/FAILED TASK
// Optional: attach a multipart file field "frame" to replace the
// continuity image at the resume point with a manually uploaded one.
// ============================================================
app.post('/api/task/resume/:taskId', upload.single('frame'), async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = taskManager.getTask(taskId);

    if (!task) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status !== 'stopped' && task.status !== 'failed') {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Task is '${task.status}', not stopped or failed — nothing to resume.` });
    }

    let manualFramePath = null;
    if (req.file) {
      if (!req.file.mimetype.startsWith('image/')) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Replacement frame must be an image' });
      }
      manualFramePath = path.join(__dirname, 'uploads/frames', `resume-${uuidv4()}${path.extname(req.file.originalname)}`);
      fs.renameSync(req.file.path, manualFramePath);
    }

    // Start async resume
    setImmediate(() => {
      storyEngine.resumeStory(taskId, () => {}, manualFramePath);
    });

    res.json({ success: true, message: 'Resuming generation' });
  } catch (error) {
    console.error('Resume error:', error);
    res.status(500).json({ error: 'Resume failed', message: error.message });
  }
});

// ============================================================
// REGENERATE SINGLE SEGMENT
// ============================================================
app.post('/api/task/regenerate/:taskId/:segmentIndex', async (req, res) => {
  const { taskId, segmentIndex } = req.params;
  const idx = parseInt(segmentIndex);

  const task = taskManager.getTask(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (idx < 0 || idx >= task.segments.length) {
    return res.status(400).json({ error: 'Invalid segment index' });
  }

  // Start async regeneration
  setImmediate(() => {
    storyEngine.regenerateSegment(taskId, idx, () => {});
  });

  res.json({ success: true, message: `Regenerating segment ${idx + 1}` });
});

// ============================================================
// EXPORT GENERATED SO FAR (partial merge)
// ============================================================
app.post('/api/task/export/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const result = await storyEngine.mergeCompletedSegments(taskId);

    if (result.success) {
      res.json({ success: true, videoUrl: result.videoUrl });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});

// ============================================================
// FINAL MERGE
// ============================================================
app.post('/api/task/merge/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const result = await storyEngine.mergeCompletedSegments(taskId);

    if (result.success) {
      res.json({ success: true, videoUrl: result.videoUrl });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: 'Merge failed', message: error.message });
  }
});

// ============================================================
// DOWNLOAD FINAL VIDEO
// ============================================================
app.get('/api/task/download/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = taskManager.getTask(taskId);

  if (!task || !task.finalVideoPath) {
    return res.status(404).json({ error: 'Video not found' });
  }

  if (!fs.existsSync(task.finalVideoPath)) {
    return res.status(404).json({ error: 'Video file not found' });
  }

  res.download(task.finalVideoPath, `story-${taskId}.mp4`);
});

// ============================================================
// LIST ALL TASKS
// ============================================================
app.get('/api/tasks', (req, res) => {
  const tasks = taskManager.getAllTasks().map(t => ({
    id: t.id,
    type: t.type,
    status: t.status,
    totalSegments: t.segments.length,
    completedSegments: t.segments.filter(s => s.status === 'completed').length,
    createdAt: t.createdAt,
  }));
  res.json(tasks);
});

// ============================================================
// TAB 2: STORY WRITER - LLM ASSISTED
// ============================================================
app.post('/api/writer/generate', async (req, res) => {
  try {
    const { summary, style } = req.body;

    if (!summary || summary.trim().length < 5) {
      return res.status(400).json({ error: 'Summary too short', message: 'Please provide at least 5 characters.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const prompt = `You are a creative story writer. Given this short summary, write a vivid, engaging animated story suitable for a 30-60 second video.

SUMMARY: "${summary}"
${style ? `VISUAL STYLE CONTEXT: "${style}"` : ''}

Write a complete story with:
- Clear beginning, middle, and end
- Vivid visual descriptions
- Engaging characters and actions
- Suitable for animation

Write the full story now:`;

    const stream = await qwenClient.chat.completions.create({
      model: QWEN_MODEL,
      messages: [
        { role: 'system', content: 'You are a creative story writer specializing in short animated stories.' },
        { role: 'user', content: prompt }
      ],
      stream: true,
      temperature: 0.8,
      max_tokens: 1500,
    });

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const delta = chunk.choices[0].delta || {};
        if (delta.content) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: delta.content })}\n\n`);
        }
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Writer error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

app.post('/api/writer/refine', async (req, res) => {
  try {
    const { story, instruction } = req.body;

    if (!story || story.trim().length < 10) {
      return res.status(400).json({ error: 'Story too short' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const prompt = `You are a story editor. Refine this story based on the instruction.

ORIGINAL STORY:
"${story}"

INSTRUCTION: ${instruction || 'Make it more vivid, engaging, and visually descriptive for animation.'}

Return ONLY the refined story, no explanations:`;

    const stream = await qwenClient.chat.completions.create({
      model: QWEN_MODEL,
      messages: [
        { role: 'system', content: 'You are a story editor. Return only the refined story.' },
        { role: 'user', content: prompt }
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 1500,
    });

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const delta = chunk.choices[0].delta || {};
        if (delta.content) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: delta.content })}\n\n`);
        }
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Refine error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// ============================================================
// TAB 3: CONTINUE STORY - FILE UPLOAD
// ============================================================
app.post('/api/continue/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const tempPath = req.file.path;
    const isVideo = req.file.mimetype.startsWith('video/');
    const isImage = req.file.mimetype.startsWith('image/');

    let framePath = null;
    let frameUrl = null;

    if (isVideo) {
      // Validate video duration (max 5 seconds)
      const videoInfo = await ffmpegUtils.getVideoInfo(tempPath);
      if (videoInfo.duration > 5) {
        fs.unlinkSync(tempPath);
        return res.status(400).json({
          error: 'Video too long',
          message: `Video is ${videoInfo.duration.toFixed(1)}s. Maximum is 5 seconds.`,
          duration: videoInfo.duration,
        });
      }

      // Extract last frame
      framePath = path.join(__dirname, 'uploads/frames', `continue-${uuidv4()}.jpg`);
      await ffmpegUtils.extractLastFrame(tempPath, framePath);

      // Delete temp video
      fs.unlinkSync(tempPath);
    } else if (isImage) {
      // Move image to frames directory
      framePath = path.join(__dirname, 'uploads/frames', `continue-${uuidv4()}${path.extname(req.file.originalname)}`);
      fs.renameSync(tempPath, framePath);
    }

    // Upload to imgbb for Pixazo
    const hostedUrl = await uploadImageToImgbb(framePath);
    if (!hostedUrl) {
      return res.status(500).json({ error: 'Failed to host frame image' });
    }

    res.json({
      success: true,
      type: isVideo ? 'video' : 'image',
      framePath,
      frameUrl: `/uploads/frames/${path.basename(framePath)}`,
      hostedUrl,
    });
  } catch (error) {
    console.error('Upload error:', error);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large', message: 'Maximum file size is 10MB' });
    }
    res.status(500).json({ error: 'Upload failed', message: error.message });
  }
});

app.post('/api/continue/generate', async (req, res) => {
  try {
    const { style, script, duration = 30, segmentDuration = 5, segments, initialFrameUrl } = req.body;

    if (!initialFrameUrl) {
      return res.status(400).json({ error: 'Initial frame URL required' });
    }

    const taskId = uuidv4();
    const numSegments = Math.ceil(duration / segmentDuration);

    const segmentsData = (segments || []).map((s, i) => ({
      index: i,
      prompt: s.prompt,
      status: 'pending',
      videoPath: null,
      videoUrl: null,
      framePath: null,
      frameUrl: null,
      versions: [],
      error: null,
    }));

    const task = taskManager.createTask({
      id: taskId,
      type: 'continue-story',
      metadata: {
        style: style?.trim() || '',
        script: script?.trim() || '',
        duration,
        segmentDuration,
        totalSegments: numSegments,
        initialFrameUrl,
      },
      segments: segmentsData,
    });

    setImmediate(() => {
      storyEngine.processStory(taskId, () => {}, initialFrameUrl);
    });

    const minTime = numSegments * 4;
    const maxTime = numSegments * 5;

    res.json({
      taskId,
      status: 'initialized',
      numSegments,
      estimatedTime: { min: minTime, max: maxTime },
      segments: task.segments,
    });
  } catch (error) {
    console.error('Continue generate error:', error);
    res.status(500).json({ error: 'Failed to start', message: error.message });
  }
});

// ============================================================
// TAB 4: GENERATE FROM SCENES
// ============================================================
app.post('/api/scenes/upload', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    if (!req.file.mimetype.startsWith('image/')) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Only images allowed' });
    }

    const imagePath = path.join(__dirname, 'uploads/frames', `scene-${uuidv4()}${path.extname(req.file.originalname)}`);
    fs.renameSync(req.file.path, imagePath);

    res.json({
      success: true,
      imagePath,
      imageUrl: `/uploads/frames/${path.basename(imagePath)}`,
    });
  } catch (error) {
    console.error('Scene upload error:', error);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large', message: 'Maximum 10MB' });
    }
    res.status(500).json({ error: 'Upload failed', message: error.message });
  }
});

// AI-assisted prompt drafting for a single scene. User gives a rough
// idea, gets back one drafted video-generation prompt they can then edit.
app.post('/api/scenes/draft-prompt', async (req, res) => {
  try {
    const { idea, style } = req.body;

    if (!idea || idea.trim().length < 2) {
      return res.status(400).json({ error: 'Please provide a short idea for this scene' });
    }

    const prompt = `Turn this rough idea into a single, vivid, detailed video-generation prompt for a short 5-second AI video clip. Describe the visual action, camera movement, and mood in one dense paragraph. Do not add commentary, labels, or quotation marks — output ONLY the prompt text itself.

ROUGH IDEA: "${idea.trim()}"
${style ? `VISUAL STYLE: "${style.trim()}"` : ''}`;

    const completion = await qwenClient.chat.completions.create({
      model: QWEN_MODEL,
      messages: [
        { role: 'system', content: 'You write concise, vivid prompts for AI video generation. Output only the prompt text, nothing else.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 220,
    });

    const draft = completion.choices?.[0]?.message?.content?.trim() || '';

    if (!draft) {
      return res.status(500).json({ error: 'Failed to draft a prompt' });
    }

    res.json({ success: true, prompt: draft.replace(/^["']|["']$/g, '') });
  } catch (error) {
    console.error('Scene draft-prompt error:', error);
    res.status(500).json({ error: 'Failed to draft prompt', message: error.message });
  }
});

app.post('/api/scenes/generate', async (req, res) => {
  try {
    const { scenes } = req.body;

    if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: 'No scenes provided' });
    }

    const taskId = uuidv4();

    const segmentsData = scenes.map((scene, i) => ({
      index: i,
      prompt: scene.prompt || '',
      imageUrl: scene.imageUrl,
      imagePath: scene.imagePath,
      status: 'pending',
      videoPath: null,
      videoUrl: null,
      framePath: null,
      frameUrl: null,
      versions: [],
      error: null,
    }));

    const task = taskManager.createTask({
      id: taskId,
      type: 'generate-scenes',
      metadata: {
        totalScenes: scenes.length,
        totalSegments: scenes.length,
      },
      segments: segmentsData,
    });

    setImmediate(() => {
      storyEngine.processScenes(taskId, () => {});
    });

    const minTime = scenes.length * 4;
    const maxTime = scenes.length * 5;

    res.json({
      taskId,
      status: 'initialized',
      numSegments: scenes.length,
      estimatedTime: { min: minTime, max: maxTime },
      segments: task.segments,
    });
  } catch (error) {
    console.error('Scenes generate error:', error);
    res.status(500).json({ error: 'Failed to start', message: error.message });
  }
});

// Regenerate a single scene. Optionally accepts a multipart "image"
// field to replace that scene's seed image before regenerating.
app.post('/api/scenes/regenerate/:taskId/:sceneIndex', upload.single('image'), async (req, res) => {
  try {
    const { taskId, sceneIndex } = req.params;
    const idx = parseInt(sceneIndex);

    const task = taskManager.getTask(taskId);
    if (!task) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Task not found' });
    }
    if (idx < 0 || idx >= task.segments.length) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid scene index' });
    }

    const { prompt } = req.body;
    const segment = task.segments[idx];
    const updates = {};

    if (prompt && prompt.trim()) {
      updates.prompt = prompt.trim();
    }

    if (req.file) {
      if (!req.file.mimetype.startsWith('image/')) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Only images allowed' });
      }
      const imagePath = path.join(__dirname, 'uploads/frames', `scene-${uuidv4()}${path.extname(req.file.originalname)}`);
      fs.renameSync(req.file.path, imagePath);

      if (segment.imagePath && fs.existsSync(segment.imagePath)) {
        try { fs.unlinkSync(segment.imagePath); } catch (e) {}
      }
      updates.imagePath = imagePath;
      updates.imageUrl = `/uploads/frames/${path.basename(imagePath)}`;
    }

    if (Object.keys(updates).length > 0) {
      taskManager.updateSegment(taskId, idx, updates);
    }

    setImmediate(() => {
      storyEngine.regenerateScene(taskId, idx, () => {});
    });

    res.json({ success: true, message: `Regenerating scene ${idx + 1}` });
  } catch (error) {
    console.error('Scene regenerate error:', error);
    res.status(500).json({ error: 'Failed to regenerate scene', message: error.message });
  }
});

// ============================================================
// VIDEO GENERATION ENDPOINT (Pixazo)
// ============================================================
app.post('/api/generate-video', async (req, res) => {
  try {
    const { prompt, config = {} } = req.body;

    if (!prompt || prompt.trim().length < 3) {
      return res.status(400).json({ error: 'Prompt too short', message: 'Please provide at least 3 characters.' });
    }

    const useImageToVideo = !!config.imageUrl;
    const endpoint = useImageToVideo
      ? 'https://gateway.pixazo.ai/ltx-video/v1/image-to-video'
      : 'https://gateway.pixazo.ai/ltx-video/v1/text-to-video';

    const payload = useImageToVideo
      ? {
          prompt,
          image_url: config.imageUrl,
          aspect: config.aspect || '16:9',
          num_frames: config.num_frames || 121,
          frame_rate: config.frame_rate || 24,
          enhance_prompt: config.enhance_prompt || 'false',
        }
      : {
          prompt,
          aspect: config.aspect || '16:9',
          num_frames: config.num_frames || 121,
          frame_rate: config.frame_rate || 24,
          enhance_prompt: config.enhance_prompt || 'false',
        };

    console.log(useImageToVideo
      ? `🎬 Generating (image-to-video): "${prompt.slice(0, 50)}..."`
      : `🎬 Generating (text-to-video): "${prompt.slice(0, 50)}..."`);

    const pixazoResponse = await axios.post(endpoint, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': process.env.PIXAZO_API_KEY,
      },
      timeout: 60000,
    });

    const data = pixazoResponse.data;

    if (data.output) {
      res.json({ completed: true, mediaUrl: data.output });
    } else if (data.request_id) {
      res.json({ completed: false, requestId: data.request_id, status: data.status || 'QUEUED' });
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('Video generation error:', error.message);
    res.status(500).json({ error: 'Video generation failed', message: error.message });
  }
});

// ============================================================
// ERROR HANDLING
// ============================================================
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ============================================================
// SERVER START
// ============================================================
// ============================================================
// PERIODIC CLEANUP
// Prevents /uploads and /tasks from growing forever, which matters
// on platforms with a fixed disk (Railway) as much as unlimited ones.
// ============================================================
const TASK_TTL_HOURS = parseInt(process.env.TASK_TTL_HOURS || '24', 10);
taskManager.cleanupOldTasks(TASK_TTL_HOURS);
setInterval(() => taskManager.cleanupOldTasks(TASK_TTL_HOURS), 60 * 60 * 1000); // hourly

app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(60));
  console.log('🎬 Animated Video Studio - ALL TABS LIVE');
  console.log('═'.repeat(60));
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🤖 Qwen Model: ${QWEN_MODEL}`);
  console.log(`🔑 Qwen API: ${process.env.QWEN_API_KEY ? '✅' : '❌'}`);
  console.log(`🔑 Qwen Workspace ID: ${process.env.QWEN_WORKSPACE_ID ? '✅' : '❌ (baseURL will contain "undefined")'}`);
  console.log(`🌍 Qwen Region: ${process.env.QWEN_REGION || 'ap-southeast-1 (default)'}`);
  console.log(`🔗 Qwen baseURL: ${qwenClient.baseURL}`);
  console.log(`🔑 Pixazo API: ${process.env.PIXAZO_API_KEY ? '✅' : '❌'}`);
  console.log(`🔑 ImgBB API: ${process.env.IMGBB_API_KEY ? '✅' : '❌'}`);
  console.log(`🔒 Access key gate: ${APP_ACCESS_KEY ? '✅ enabled' : '❌ DISABLED (open access)'}`);
  console.log(`📁 Uploads: ${path.join(__dirname, 'uploads')}`);
  console.log(`📁 Tasks: ${path.join(__dirname, 'tasks')}`);
  console.log('═'.repeat(60));
  console.log('🌐 Open in browser:');
  console.log(`   http://localhost:${PORT}`);
  console.log('═'.repeat(60) + '\n');
});