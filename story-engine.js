// story-engine.js - Complete with stop/resume/regenerate support
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpegUtils = require('./ffmpeg-utils');
const { uploadImageToImgbb } = require('./image-host');
const taskManager = require('./task-manager');

const PIXAZO_API_KEY = process.env.PIXAZO_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

const VIDEO_CONFIG = {
  modelId: 'ltx',
  aspect: '16:9',
  num_frames: 121,
  frame_rate: 24,
  enhance_prompt: 'false',
};

// Track active generation loops for stop functionality
const activeGenerations = new Map();

async function pollVideoStatus(requestId, maxAttempts = 400, interval = 3000) {
  console.log(`⏳ Polling for video: ${requestId}`);
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check if generation was stopped
    if (!activeGenerations.has(requestId)) {
      console.log(`⏹️ Generation stopped for: ${requestId}`);
      return { success: false, error: 'Generation stopped by user' };
    }

    await new Promise(resolve => setTimeout(resolve, interval));
    
    try {
      const response = await axios.get(
        `https://gateway.pixazo.ai/v2/requests/status/${requestId}`,
        { headers: { 'Ocp-Apim-Subscription-Key': PIXAZO_API_KEY } }
      );
      
      const data = response.data;
      console.log(`   Attempt ${attempt + 1}/${maxAttempts}: ${data.status}`);
      
      if (data.status === 'COMPLETED') {
        const mediaUrl = data.output?.media_url?.[0] || data.output;
        if (mediaUrl) {
          console.log(`✅ Video completed!`);
          return { success: true, mediaUrl };
        }
        return { success: false, error: 'No media URL in completed response' };
      } else if (data.status === 'FAILED' || data.status === 'ERROR') {
        return { success: false, error: data.error || 'Video generation failed' };
      }
    } catch (error) {
      if (error.response?.status === 404) {
        console.log(`   ⚠️ Request not found yet (attempt ${attempt + 1})`);
      } else {
        console.log(`   ⚠️ Poll error: ${error.message}`);
      }
    }
  }
  
  return { success: false, error: 'Video generation timed out' };
}

async function generateVideoWithPixazo(prompt, segmentIndex, seedImageUrl = null, taskId = null) {
  console.log(`🎬 Generating video ${segmentIndex + 1}: "${prompt.slice(0, 40)}..."`);
  
  try {
    // This is a self-call: the server calling back into its own
    // /api/generate-video route over HTTP. If APP_ACCESS_KEY is set,
    // that route is gated, so we must attach the same key here or
    // every generation will fail with 401 Unauthorized.
    const response = await axios.post(
      `${PUBLIC_BASE_URL}/api/generate-video`,
      {
        prompt: prompt,
        config: seedImageUrl ? { ...VIDEO_CONFIG, imageUrl: seedImageUrl } : VIDEO_CONFIG,
      },
      {
        timeout: 60000,
        headers: process.env.APP_ACCESS_KEY ? { 'x-app-key': process.env.APP_ACCESS_KEY } : {},
      }
    );

    const data = response.data;
    
    if (data.completed && data.mediaUrl) {
      console.log('✅ Video generated (sync)');
      return { success: true, mediaUrl: data.mediaUrl };
    } else if (data.requestId) {
      console.log(`⏳ Video queued: ${data.requestId}`);
      // Track this generation for stop functionality
      if (taskId) {
        activeGenerations.set(data.requestId, taskId);
      }
      const result = await pollVideoStatus(data.requestId);
      if (taskId) {
        activeGenerations.delete(data.requestId);
      }
      return result;
    } else {
      const mediaUrl = data.output?.media_url?.[0] || data.output || data.imageUrl || data.url;
      if (mediaUrl) {
        console.log('✅ Video generated (from response)');
        return { success: true, mediaUrl };
      }
      return { success: false, error: 'Unexpected response from video generation' };
    }
  } catch (error) {
    console.error('❌ Video generation request failed:', error.message);
    return { success: false, error: error.message };
  }
}

async function downloadVideo(url, outputPath) {
  console.log(`📥 Downloading video to ${path.basename(outputPath)}`);
  
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 120000,
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
    });

    console.log(`✅ Video downloaded: ${path.basename(outputPath)}`);
    return outputPath;
  } catch (error) {
    console.error('❌ Download failed:', error.message);
    throw error;
  }
}

async function processStory(taskId, onUpdate, initialFrameUrl = null) {
  const task = taskManager.getTask(taskId);
  if (!task) {
    onUpdate({ status: 'failed', error: 'Task not found' });
    return;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`🚀 Starting story processing: ${taskId}`);
  console.log(`📝 Script: "${task.metadata.script?.slice(0, 60)}..."`);
  console.log(`📊 Segments: ${task.segments.length}`);
  console.log('═'.repeat(60));

  try {
    taskManager.updateTask(taskId, { status: 'generating', error: null });

    let previousFrameUrl = initialFrameUrl;

    for (let i = 0; i < task.segments.length; i++) {
      // Check if task was stopped
      const currentTask = taskManager.getTask(taskId);
      if (currentTask.status === 'stopped') {
        console.log(`⏹️ Task stopped at segment ${i}`);
        break;
      }

      const segment = task.segments[i];
      
      // Skip if already completed
      if (segment.status === 'completed') {
        console.log(`⏭️ Segment ${i + 1} already completed, skipping`);
        if (segment.framePath && fs.existsSync(segment.framePath)) {
          // Re-host the frame for continuity
          const hostedUrl = await uploadImageToImgbb(segment.framePath);
          if (hostedUrl) {
            previousFrameUrl = hostedUrl;
          }
        }
        continue;
      }

      taskManager.updateSegment(taskId, i, { status: 'generating' });
      onUpdate({ segments: task.segments, currentSegment: i });

      console.log(`\n📹 Generating segment ${i + 1}/${task.segments.length}`);
      console.log(`   Prompt: "${segment.prompt.slice(0, 60)}..."`);

      const result = await generateVideoWithPixazo(
        segment.prompt,
        i,
        previousFrameUrl,
        taskId
      );

      if (!result.success) {
        if (result.error === 'Generation stopped by user') {
          taskManager.updateTask(taskId, { status: 'stopped' });
          break;
        }

        taskManager.updateSegment(taskId, i, {
          status: 'failed',
          error: result.error,
        });
        onUpdate({ segments: task.segments, status: 'failed', error: result.error });
        return;
      }

      if (result.mediaUrl) {
        const videoFilename = `segment-${i}-${uuidv4()}.mp4`;
        const videoPath = path.join(__dirname, 'uploads/videos', videoFilename);

        try {
          await downloadVideo(result.mediaUrl, videoPath);
        } catch (downloadError) {
          taskManager.updateSegment(taskId, i, {
            status: 'failed',
            error: downloadError.message,
          });
          onUpdate({ segments: task.segments, status: 'failed' });
          return;
        }

        // Delete old video if regenerating
        if (segment.videoPath && fs.existsSync(segment.videoPath)) {
          fs.unlinkSync(segment.videoPath);
        }

        taskManager.updateSegment(taskId, i, {
          status: 'completed',
          videoPath: videoPath,
          videoUrl: `/uploads/videos/${videoFilename}`,
        });

        // Extract frame for next segment
        previousFrameUrl = null;
        if (i < task.segments.length - 1) {
          const frameFilename = `frame-${i}-${uuidv4()}.jpg`;
          const framePath = path.join(__dirname, 'uploads/frames', frameFilename);

          try {
            await ffmpegUtils.extractLastFrame(videoPath, framePath);
            
            // Delete old frame if regenerating
            if (segment.framePath && fs.existsSync(segment.framePath)) {
              fs.unlinkSync(segment.framePath);
            }

            taskManager.updateSegment(taskId, i, {
              framePath: framePath,
              frameUrl: `/uploads/frames/${frameFilename}`,
            });

            console.log('   📸 Frame extracted for next segment');

            const hostedUrl = await uploadImageToImgbb(framePath);
            if (hostedUrl) {
              previousFrameUrl = hostedUrl;
              console.log(`   🔗 Frame hosted: ${hostedUrl}`);
            }
          } catch (err) {
            console.warn('   ⚠️ Frame extraction failed, continuing without continuity...');
          }
        }

        onUpdate({ segments: task.segments, completedSegments: i + 1 });
      }
    }

    const finalTask = taskManager.getTask(taskId);
    if (finalTask.status !== 'stopped') {
      taskManager.updateTask(taskId, { status: 'completed' });
      console.log('\n✅ Story complete! 🎉');
    } else {
      console.log('\n⏹️ Story stopped by user');
    }

    onUpdate({ status: finalTask.status, segments: finalTask.segments });
  } catch (error) {
    console.error(`\n❌ Story failed: ${taskId}`);
    console.error(`Error:`, error.message);
    taskManager.updateTask(taskId, { status: 'failed', error: error.message });
    onUpdate({ status: 'failed', error: error.message });
  }
}

async function regenerateSegment(taskId, segmentIndex, onUpdate) {
  const task = taskManager.getTask(taskId);
  if (!task) {
    onUpdate({ status: 'failed', error: 'Task not found' });
    return;
  }

  const segment = task.segments[segmentIndex];
  if (!segment) {
    onUpdate({ status: 'failed', error: 'Segment not found' });
    return;
  }

  console.log(`\n🔄 Regenerating segment ${segmentIndex + 1}`);

  taskManager.updateSegment(taskId, segmentIndex, { status: 'generating' });
  onUpdate({ segments: task.segments, currentSegment: segmentIndex });

  // Get previous frame for continuity
  let previousFrameUrl = null;
  if (segmentIndex > 0) {
    const prevSegment = task.segments[segmentIndex - 1];
    if (prevSegment.framePath && fs.existsSync(prevSegment.framePath)) {
      previousFrameUrl = await uploadImageToImgbb(prevSegment.framePath);
    }
  }

  const result = await generateVideoWithPixazo(
    segment.prompt,
    segmentIndex,
    previousFrameUrl,
    taskId
  );

  if (!result.success) {
    taskManager.updateSegment(taskId, segmentIndex, {
      status: 'failed',
      error: result.error,
    });
    onUpdate({ segments: task.segments, status: 'failed' });
    return;
  }

  if (result.mediaUrl) {
    const videoFilename = `segment-${segmentIndex}-${uuidv4()}.mp4`;
    const videoPath = path.join(__dirname, 'uploads/videos', videoFilename);

    await downloadVideo(result.mediaUrl, videoPath);

    // Delete old video
    if (segment.videoPath && fs.existsSync(segment.videoPath)) {
      fs.unlinkSync(segment.videoPath);
    }

    taskManager.updateSegment(taskId, segmentIndex, {
      status: 'completed',
      videoPath: videoPath,
      videoUrl: `/uploads/videos/${videoFilename}`,
    });

    // Extract frame for next segment
    if (segmentIndex < task.segments.length - 1) {
      const frameFilename = `frame-${segmentIndex}-${uuidv4()}.jpg`;
      const framePath = path.join(__dirname, 'uploads/frames', frameFilename);

      await ffmpegUtils.extractLastFrame(videoPath, framePath);

      if (segment.framePath && fs.existsSync(segment.framePath)) {
        fs.unlinkSync(segment.framePath);
      }

      taskManager.updateSegment(taskId, segmentIndex, {
        framePath: framePath,
        frameUrl: `/uploads/frames/${frameFilename}`,
      });
    }

    onUpdate({ segments: task.segments, completedSegments: segmentIndex + 1 });
  }
}

/**
 * Process the "Generate from Scenes" tab. Unlike processStory, each
 * segment has its OWN seed image (uploaded by the user) rather than
 * chaining the last frame of the previous segment, so scenes can be
 * generated/regenerated independently of one another.
 */
async function processScenes(taskId, onUpdate) {
  const task = taskManager.getTask(taskId);
  if (!task) {
    onUpdate({ status: 'failed', error: 'Task not found' });
    return;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`🎬 Starting scenes processing: ${taskId}`);
  console.log(`📊 Scenes: ${task.segments.length}`);
  console.log('═'.repeat(60));

  try {
    taskManager.updateTask(taskId, { status: 'generating', error: null });

    for (let i = 0; i < task.segments.length; i++) {
      const currentTask = taskManager.getTask(taskId);
      if (currentTask.status === 'stopped') {
        console.log(`⏹️ Scenes task stopped at scene ${i}`);
        break;
      }

      const segment = task.segments[i];

      if (segment.status === 'completed') {
        console.log(`⏭️ Scene ${i + 1} already completed, skipping`);
        continue;
      }

      taskManager.updateSegment(taskId, i, { status: 'generating' });
      onUpdate({ segments: task.segments, currentSegment: i });

      console.log(`\n📹 Generating scene ${i + 1}/${task.segments.length}`);
      console.log(`   Prompt: "${(segment.prompt || '').slice(0, 60)}..."`);

      // Host this scene's own image (if provided) as the seed frame
      let seedImageUrl = null;
      if (segment.imagePath && fs.existsSync(segment.imagePath)) {
        seedImageUrl = await uploadImageToImgbb(segment.imagePath);
      }

      const result = await generateVideoWithPixazo(segment.prompt, i, seedImageUrl, taskId);

      if (!result.success) {
        if (result.error === 'Generation stopped by user') {
          taskManager.updateTask(taskId, { status: 'stopped' });
          break;
        }
        taskManager.updateSegment(taskId, i, { status: 'failed', error: result.error });
        onUpdate({ segments: task.segments, status: 'failed', error: result.error });
        return;
      }

      if (result.mediaUrl) {
        const videoFilename = `scene-${i}-${uuidv4()}.mp4`;
        const videoPath = path.join(__dirname, 'uploads/videos', videoFilename);

        try {
          await downloadVideo(result.mediaUrl, videoPath);
        } catch (downloadError) {
          taskManager.updateSegment(taskId, i, { status: 'failed', error: downloadError.message });
          onUpdate({ segments: task.segments, status: 'failed' });
          return;
        }

        if (segment.videoPath && fs.existsSync(segment.videoPath)) {
          try { fs.unlinkSync(segment.videoPath); } catch (e) {}
        }

        taskManager.updateSegment(taskId, i, {
          status: 'completed',
          videoPath,
          videoUrl: `/uploads/videos/${videoFilename}`,
        });

        onUpdate({ segments: task.segments, completedSegments: i + 1 });
      }
    }

    const finalTask = taskManager.getTask(taskId);
    if (finalTask.status !== 'stopped') {
      taskManager.updateTask(taskId, { status: 'completed' });
      console.log('\n✅ Scenes complete! 🎉');
    } else {
      console.log('\n⏹️ Scenes stopped by user');
    }

    onUpdate({ status: finalTask.status, segments: finalTask.segments });
  } catch (error) {
    console.error(`\n❌ Scenes processing failed: ${taskId}`, error.message);
    taskManager.updateTask(taskId, { status: 'failed', error: error.message });
    onUpdate({ status: 'failed', error: error.message });
  }
}

/**
 * Regenerate a single scene in a "Generate from Scenes" task. Reuses
 * that scene's own seed image (or a freshly uploaded replacement,
 * passed in via segment.imagePath already having been updated by the caller).
 */
async function regenerateScene(taskId, segmentIndex, onUpdate) {
  const task = taskManager.getTask(taskId);
  if (!task) {
    onUpdate({ status: 'failed', error: 'Task not found' });
    return;
  }

  const segment = task.segments[segmentIndex];
  if (!segment) {
    onUpdate({ status: 'failed', error: 'Scene not found' });
    return;
  }

  console.log(`\n🔄 Regenerating scene ${segmentIndex + 1}`);
  taskManager.updateSegment(taskId, segmentIndex, { status: 'generating' });
  onUpdate({ segments: task.segments, currentSegment: segmentIndex });

  let seedImageUrl = null;
  if (segment.imagePath && fs.existsSync(segment.imagePath)) {
    seedImageUrl = await uploadImageToImgbb(segment.imagePath);
  }

  const result = await generateVideoWithPixazo(segment.prompt, segmentIndex, seedImageUrl, taskId);

  if (!result.success) {
    taskManager.updateSegment(taskId, segmentIndex, { status: 'failed', error: result.error });
    onUpdate({ segments: task.segments, status: 'failed' });
    return;
  }

  if (result.mediaUrl) {
    const videoFilename = `scene-${segmentIndex}-${uuidv4()}.mp4`;
    const videoPath = path.join(__dirname, 'uploads/videos', videoFilename);
    await downloadVideo(result.mediaUrl, videoPath);

    if (segment.videoPath && fs.existsSync(segment.videoPath)) {
      try { fs.unlinkSync(segment.videoPath); } catch (e) {}
    }

    taskManager.updateSegment(taskId, segmentIndex, {
      status: 'completed',
      videoPath,
      videoUrl: `/uploads/videos/${videoFilename}`,
    });

    onUpdate({ segments: task.segments, completedSegments: segmentIndex + 1 });
  }
}

function stopGeneration(taskId) {
  const task = taskManager.getTask(taskId);
  if (!task) return false;

  taskManager.updateTask(taskId, { status: 'stopped' });
  console.log(`⏹️ Stopping generation for task: ${taskId}`);
  return true;
}

/**
 * Resume a stopped/failed task from the first non-completed segment.
 * If manualFramePath is provided (an uploaded replacement frame), it is
 * hosted and used as the continuity seed for the resume point instead
 * of whatever frame was auto-extracted before the stop.
 */
async function resumeStory(taskId, onUpdate, manualFramePath = null) {
  const task = taskManager.getTask(taskId);
  if (!task) {
    onUpdate({ status: 'failed', error: 'Task not found' });
    return;
  }

  if (task.status !== 'stopped' && task.status !== 'failed') {
    console.log(`⚠️ Task ${taskId} is not stopped/failed (status: ${task.status}), ignoring resume`);
    return;
  }

  const resumeIndex = task.segments.findIndex(s => s.status !== 'completed');
  console.log(`\n▶️ Resuming task ${taskId} from segment ${resumeIndex + 1}`);

  let initialFrameUrl = null;

  if (manualFramePath && fs.existsSync(manualFramePath)) {
    const hostedUrl = await uploadImageToImgbb(manualFramePath);
    if (!hostedUrl) {
      onUpdate({ status: 'failed', error: 'Failed to host the uploaded replacement frame' });
      return;
    }

    if (resumeIndex > 0) {
      // Attach the manual frame to the last completed segment so the
      // existing skip/re-host logic in processStory picks it up naturally.
      const prevIndex = resumeIndex - 1;
      const prevSegment = task.segments[prevIndex];
      if (prevSegment.framePath && fs.existsSync(prevSegment.framePath) && prevSegment.framePath !== manualFramePath) {
        try { fs.unlinkSync(prevSegment.framePath); } catch (e) {}
      }
      taskManager.updateSegment(taskId, prevIndex, {
        framePath: manualFramePath,
        frameUrl: `/uploads/frames/${path.basename(manualFramePath)}`,
      });
    } else {
      // Nothing completed yet — seed directly as the starting continuity frame.
      initialFrameUrl = hostedUrl;
    }
  }

  await processStory(taskId, onUpdate, initialFrameUrl);
}

async function mergeCompletedSegments(taskId) {
  const task = taskManager.getTask(taskId);
  if (!task) return { success: false, error: 'Task not found' };

  const completedSegments = task.segments.filter(s => s.status === 'completed' && s.videoPath);
  
  if (completedSegments.length === 0) {
    return { success: false, error: 'No completed segments to merge' };
  }

  console.log(`\n🎞️ Merging ${completedSegments.length} completed segments...`);

  const videoPaths = completedSegments.map(s => s.videoPath);
  const outputFilename = `final-${taskId}.mp4`;
  const outputPath = path.join(__dirname, 'uploads/output', outputFilename);

  try {
    await ffmpegUtils.concatVideos(videoPaths, outputPath);
    
    taskManager.updateTask(taskId, {
      finalVideoPath: outputPath,
      finalVideoUrl: `/uploads/output/${outputFilename}`,
    });

    console.log(`✅ Merge complete: ${outputFilename}`);
    return { success: true, videoUrl: `/uploads/output/${outputFilename}` };
  } catch (error) {
    console.error('❌ Merge failed:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  processStory,
  processScenes,
  regenerateSegment,
  regenerateScene,
  stopGeneration,
  resumeStory,
  mergeCompletedSegments,
};