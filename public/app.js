// public/app.js - Complete frontend for all 4 tabs
const API_BASE = '/api';
const FIXED_SEGMENT_DURATION = 5;

// ============================================================
// ACCESS KEY HANDLING
// If the server has APP_ACCESS_KEY set, every /api call (except
// /api/health) must include a matching x-app-key header or it gets
// a 401. To use this app against a gated server, open it once with
// ?key=YOUR_KEY in the URL — the key is cached in localStorage and
// the query param is then stripped from the address bar. If the
// server has no APP_ACCESS_KEY set, this is a harmless no-op.
// 
// NEW: Full-screen overlay that prompts for the access key if not
// already stored. The overlay covers the entire screen and only
// disappears when the correct key is entered.
// ============================================================
const ACCESS_KEY_STORAGE_KEY = 'appAccessKey';

(function initAccessKey() {
  const params = new URLSearchParams(window.location.search);
  const keyFromUrl = params.get('key');
  if (keyFromUrl) {
    try { localStorage.setItem(ACCESS_KEY_STORAGE_KEY, keyFromUrl); } catch (e) {}
    params.delete('key');
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
  }
  
  // Check if we need to show the access overlay
  checkAccessOverlay();
})();

function getAccessKey() {
  try { return localStorage.getItem(ACCESS_KEY_STORAGE_KEY) || ''; } catch (e) { return ''; }
}

// Show/hide the full-screen access overlay based on whether a key is stored
function checkAccessOverlay() {
  const overlay = document.getElementById('access-overlay');
  if (!overlay) return;
  
  const storedKey = getAccessKey();
  if (storedKey) {
    // Key exists, hide overlay
    overlay.classList.add('hidden');
  } else {
    // No key, show overlay
    overlay.classList.remove('hidden');
    // Focus the input field
    setTimeout(() => {
      const input = document.getElementById('access-key-input');
      if (input) input.focus();
    }, 100);
  }
}

// Verify the access key by making a health check request
async function verifyAccessKey(key) {
  try {
    const response = await fetch('/api/health', {
      headers: { 'x-app-key': key }
    });
    const data = await response.json();
    return response.ok && data.status === 'ok';
  } catch (error) {
    return false;
  }
}

// Handle access key submission from the overlay
async function handleAccessSubmit() {
  const overlay = document.getElementById('access-overlay');
  const input = document.getElementById('access-key-input');
  const errorEl = document.getElementById('access-error');
  const submitBtn = document.getElementById('access-submit-btn');
  
  const key = input.value.trim();
  if (!key) {
    errorEl.textContent = 'Please enter an access key';
    errorEl.style.display = 'block';
    return;
  }
  
  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ Verifying...';
  errorEl.style.display = 'none';
  
  const isValid = await verifyAccessKey(key);
  
  if (isValid) {
    try { localStorage.setItem(ACCESS_KEY_STORAGE_KEY, key); } catch (e) {}
    overlay.classList.add('hidden');
    input.value = '';
  } else {
    errorEl.textContent = 'Invalid access key. Please try again.';
    errorEl.style.display = 'block';
    input.value = '';
    input.focus();
  }
  
  submitBtn.disabled = false;
  submitBtn.textContent = 'Unlock Studio';
}

// Drop-in replacement for fetch() that attaches x-app-key to every
// /api request when a key is cached. Use this instead of the raw
// fetch() for all calls under API_BASE.
function apiFetch(url, options = {}) {
  const key = getAccessKey();
  const headers = { ...(options.headers || {}) };
  if (key) headers['x-app-key'] = key;
  return fetch(url, { ...options, headers });
}

// ============================================================
// GLOBAL STATE
// ============================================================
let currentTab = 'new-story';
let currentTasks = {
  'new-story': null,
  'continue-story': null,
  'generate-scenes': null,
};
let pollIntervals = {};

// ============================================================
// TAB NAVIGATION
// ============================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${targetTab}`).classList.add('active');
    currentTab = targetTab;
  });
});

// ============================================================
// ACCESS OVERLAY EVENT LISTENERS
// ============================================================
const accessSubmitBtn = document.getElementById('access-submit-btn');
const accessKeyInput = document.getElementById('access-key-input');

if (accessSubmitBtn) {
  accessSubmitBtn.addEventListener('click', handleAccessSubmit);
}

if (accessKeyInput) {
  // Allow pressing Enter to submit
  accessKeyInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleAccessSubmit();
    }
  });
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function showError(elementId, message) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 6000);
}

function updateTimeEstimate(inputId, estimateId) {
  const duration = parseInt(document.getElementById(inputId).value) || 5;
  const numSegments = Math.ceil(duration / FIXED_SEGMENT_DURATION);
  const minTime = numSegments * 4;
  const maxTime = numSegments * 5;
  const el = document.getElementById(estimateId);
  el.querySelector('.time-text').innerHTML = 
    `Estimated time: <strong>${minTime}-${maxTime} minutes</strong> (${numSegments} segments × 4-5 min each)`;
}

// ============================================================
// TAB 1: NEW STORY
// ============================================================
const storyStyle = document.getElementById('story-style');
const storyScript = document.getElementById('story-script');
const storyDuration = document.getElementById('story-duration');
const generateBtn = document.getElementById('generate-btn');
const stopBtn = document.getElementById('stop-btn');
const exportBtn = document.getElementById('export-btn');
const mergeBtn = document.getElementById('merge-btn');
const downloadFinalBtn = document.getElementById('download-final-btn');
const sequencePanel = document.getElementById('sequence-panel');
const sequenceGrid = document.getElementById('sequence-grid');
const reviewPanel = document.getElementById('review-panel');
const reviewList = document.getElementById('review-list');
const reviewBackBtn = document.getElementById('review-back-btn');
const reviewConfirmBtn = document.getElementById('review-confirm-btn');

// Duration steppers
document.getElementById('duration-increase').addEventListener('click', () => {
  const current = parseInt(storyDuration.value);
  if (current < 120) {
    storyDuration.value = current + 5;
    updateTimeEstimate('story-duration', 'time-estimate');
  }
});
document.getElementById('duration-decrease').addEventListener('click', () => {
  const current = parseInt(storyDuration.value);
  if (current > 5) {
    storyDuration.value = current - 5;
    updateTimeEstimate('story-duration', 'time-estimate');
  }
});
updateTimeEstimate('story-duration', 'time-estimate');

// Generate button
let pendingStory = null; // holds { style, script, duration } while the review panel is open

generateBtn.addEventListener('click', async () => {
  const style = storyStyle.value.trim();
  const script = storyScript.value.trim();

  if (style.length < 10) return showError('error-msg', 'Visual style must be at least 10 characters.');
  if (script.length < 10) return showError('error-msg', 'Story script must be at least 10 characters.');

  generateBtn.disabled = true;
  generateBtn.textContent = '⏳ Splitting story...';

  try {
    const segments = await splitStoryWithStreaming(style, script, parseInt(storyDuration.value));
    if (!segments || segments.length === 0) {
      throw new Error('Failed to split story');
    }

    // Pause here for review instead of generating immediately — show each
    // scene's prompt in an editable textarea and wait for confirmation.
    pendingStory = { style, script, duration: parseInt(storyDuration.value) };
    renderReviewList(segments);
    reviewPanel.classList.remove('hidden');
    sequencePanel.classList.add('hidden');

    generateBtn.disabled = false;
    generateBtn.textContent = '🚀 Generate Animated Video';
  } catch (error) {
    showError('error-msg', error.message);
    generateBtn.disabled = false;
    generateBtn.textContent = '🚀 Generate Animated Video';
  }
});

function renderReviewList(segments) {
  reviewList.innerHTML = segments.map((seg, i) => `
    <div class="review-card" data-index="${i}">
      <div class="review-card-head"><span>Scene ${i + 1}</span></div>
      <textarea class="review-prompt-input" data-index="${i}" rows="4">${(seg.prompt || '').replace(/</g, '&lt;')}</textarea>
    </div>
  `).join('');
}

reviewBackBtn.addEventListener('click', () => {
  reviewPanel.classList.add('hidden');
  pendingStory = null;
});

reviewConfirmBtn.addEventListener('click', async () => {
  if (!pendingStory) return;

  // Pull the (possibly edited) prompts straight from the textareas.
  const segments = Array.from(reviewList.querySelectorAll('.review-prompt-input'))
    .sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index))
    .map(el => ({ prompt: el.value.trim() }));

  if (segments.some(s => !s.prompt)) {
    return showError('review-error', 'No scene prompt can be empty.');
  }

  reviewConfirmBtn.disabled = true;
  reviewConfirmBtn.textContent = '⏳ Starting generation...';
  generateBtn.disabled = true;
  generateBtn.textContent = '⏳ Generating...';

  try {
    const { style, script, duration } = pendingStory;
    const response = await apiFetch(`${API_BASE}/story/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style, script, duration, segmentDuration: FIXED_SEGMENT_DURATION, segments }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Failed to start');

    currentTasks['new-story'] = data.taskId;
    reviewPanel.classList.add('hidden');
    pendingStory = null;

    sequencePanel.classList.remove('hidden');
    renderSequenceGrid(sequenceGrid, data.segments);

    stopBtn.classList.remove('hidden');
    exportBtn.classList.remove('hidden');

    startTaskPolling('new-story', data.taskId);
  } catch (error) {
    showError('review-error', error.message);
    generateBtn.disabled = false;
    generateBtn.textContent = '🚀 Generate Animated Video';
  } finally {
    reviewConfirmBtn.disabled = false;
    reviewConfirmBtn.textContent = '✅ Looks Good — Generate Videos';
  }
});

stopBtn.addEventListener('click', async () => {
  const taskId = currentTasks['new-story'];
  if (!taskId) return;
  await apiFetch(`${API_BASE}/task/stop/${taskId}`, { method: 'POST' });
  stopBtn.classList.add('hidden');
  generateBtn.disabled = false;
  generateBtn.textContent = '🚀 Generate Animated Video';
});

exportBtn.addEventListener('click', async () => {
  const taskId = currentTasks['new-story'];
  if (!taskId) return;
  const res = await apiFetch(`${API_BASE}/task/export/${taskId}`, { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    window.open(data.videoUrl, '_blank');
  } else {
    showError('error-msg', data.error);
  }
});

mergeBtn.addEventListener('click', async () => {
  const taskId = currentTasks['new-story'];
  if (!taskId) return;
  mergeBtn.disabled = true;
  mergeBtn.textContent = '⏳ Merging...';
  const res = await apiFetch(`${API_BASE}/task/merge/${taskId}`, { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    downloadFinalBtn.classList.remove('hidden');
    downloadFinalBtn.onclick = () => {
      const key = getAccessKey();
      const suffix = key ? `?key=${encodeURIComponent(key)}` : '';
      window.location.href = `${API_BASE}/task/download/${taskId}${suffix}`;
    };
  } else {
    showError('error-msg', data.error);
  }
  mergeBtn.disabled = false;
  mergeBtn.textContent = '🎬 Final Merge';
});

// ============================================================
// TAB 2: STORY WRITER
// ============================================================
const writerGenerateBtn = document.getElementById('writer-generate-btn');
const writerRefineBtn = document.getElementById('writer-refine-btn');
const writerCopyBtn = document.getElementById('writer-copy-btn');
const writerClearBtn = document.getElementById('writer-clear-btn');
const writerUseBtn = document.getElementById('writer-use-btn');
const writerOutput = document.getElementById('writer-output');
const writerStoryText = document.getElementById('writer-story-text');
const writerRefineInput = document.getElementById('writer-refine-input');

writerGenerateBtn.addEventListener('click', async () => {
  const summary = document.getElementById('writer-summary').value.trim();
  const style = document.getElementById('writer-style').value.trim();

  if (summary.length < 5) return showError('writer-error', 'Summary must be at least 5 characters.');

  writerGenerateBtn.disabled = true;
  writerGenerateBtn.textContent = '✨ Writing...';
  writerStoryText.value = '';
  writerOutput.classList.remove('hidden');

  try {
    const response = await apiFetch(`${API_BASE}/writer/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary, style }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'chunk') {
              writerStoryText.value += data.content;
            }
          } catch (e) {}
        }
      }
    }
  } catch (error) {
    showError('writer-error', error.message);
  } finally {
    writerGenerateBtn.disabled = false;
    writerGenerateBtn.textContent = '✨ Generate Story';
  }
});

writerRefineBtn.addEventListener('click', async () => {
  const story = writerStoryText.value.trim();
  const instruction = writerRefineInput.value.trim();

  if (story.length < 10) return showError('writer-error', 'Generate a story first.');

  writerRefineBtn.disabled = true;
  writerRefineBtn.textContent = '⏳ Refining...';
  const originalText = writerStoryText.value;
  writerStoryText.value = '';

  try {
    const response = await apiFetch(`${API_BASE}/writer/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ story, instruction }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'chunk') {
              writerStoryText.value += data.content;
            }
          } catch (e) {}
        }
      }
    }
  } catch (error) {
    writerStoryText.value = originalText;
    showError('writer-error', error.message);
  } finally {
    writerRefineBtn.disabled = false;
    writerRefineBtn.textContent = '🔄 Refine';
  }
});

writerCopyBtn.addEventListener('click', () => {
  writerStoryText.select();
  document.execCommand('copy');
  writerCopyBtn.textContent = '✅ Copied!';
  setTimeout(() => { writerCopyBtn.textContent = '📋 Copy to Clipboard'; }, 2000);
});

writerClearBtn.addEventListener('click', () => {
  writerStoryText.value = '';
  document.getElementById('writer-summary').value = '';
  document.getElementById('writer-style').value = '';
  writerRefineInput.value = '';
  writerOutput.classList.add('hidden');
});

writerUseBtn.addEventListener('click', () => {
  const story = writerStoryText.value.trim();
  const style = document.getElementById('writer-style').value.trim();
  if (!story) return showError('writer-error', 'No story to use.');

  // Switch to New Story tab and populate
  document.querySelector('[data-tab="new-story"]').click();
  storyScript.value = story;
  if (style) storyStyle.value = style;
});

// ============================================================
// TAB 3: CONTINUE STORY
// ============================================================
let continueUploadedFrame = null;
let continueUploadType = 'video';

document.querySelectorAll('.upload-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.upload-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    continueUploadType = btn.dataset.upload;
    
    const hint = document.getElementById('continue-upload-hint');
    const input = document.getElementById('continue-file-input');
    
    if (continueUploadType === 'video') {
      hint.textContent = 'Video: MP4, max 10MB, max 5 seconds';
      input.accept = 'video/mp4,video/quicktime,video/webm';
    } else {
      hint.textContent = 'Image: JPG, PNG, WebP, max 10MB';
      input.accept = 'image/jpeg,image/png,image/webp';
    }
    
    continueUploadedFrame = null;
    document.getElementById('continue-preview').classList.add('hidden');
  });
});

const continueDropZone = document.getElementById('continue-drop-zone');
const continueFileInput = document.getElementById('continue-file-input');

continueDropZone.addEventListener('click', () => continueFileInput.click());
continueDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  continueDropZone.classList.add('drag-over');
});
continueDropZone.addEventListener('dragleave', () => continueDropZone.classList.remove('drag-over'));
continueDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  continueDropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) {
    handleContinueUpload(e.dataTransfer.files[0]);
  }
});
continueFileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) handleContinueUpload(e.target.files[0]);
});

async function handleContinueUpload(file) {
  if (file.size > 10 * 1024 * 1024) {
    return showError('continue-error', 'File too large. Maximum 10MB.');
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await apiFetch(`${API_BASE}/continue/upload`, {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    if (!response.ok) {
      return showError('continue-error', data.message || data.error);
    }

    continueUploadedFrame = data;
    
    const preview = document.getElementById('continue-preview');
    preview.classList.remove('hidden');
    preview.innerHTML = `
      <div class="preview-content">
        ${data.type === 'video' 
          ? `<video src="${data.frameUrl}" style="max-width:200px;"></video>`
          : `<img src="${data.frameUrl}" style="max-width:200px;">`}
        <div class="preview-info">
          <strong>✅ ${data.type === 'video' ? 'Video' : 'Image'} uploaded</strong>
          <p>Last frame extracted and hosted</p>
        </div>
      </div>
    `;
  } catch (error) {
    showError('continue-error', error.message);
  }
}

// Continue duration steppers
document.getElementById('continue-duration-increase').addEventListener('click', () => {
  const input = document.getElementById('continue-duration');
  const current = parseInt(input.value);
  if (current < 60) {
    input.value = current + 5;
    updateTimeEstimate('continue-duration', 'continue-time-estimate');
  }
});
document.getElementById('continue-duration-decrease').addEventListener('click', () => {
  const input = document.getElementById('continue-duration');
  const current = parseInt(input.value);
  if (current > 5) {
    input.value = current - 5;
    updateTimeEstimate('continue-duration', 'continue-time-estimate');
  }
});
updateTimeEstimate('continue-duration', 'continue-time-estimate');

document.getElementById('continue-generate-btn').addEventListener('click', async () => {
  if (!continueUploadedFrame) return showError('continue-error', 'Please upload a video or image first.');
  
  const style = document.getElementById('continue-style').value.trim();
  const script = document.getElementById('continue-script').value.trim();
  
  if (style.length < 10) return showError('continue-error', 'Visual style must be at least 10 characters.');
  if (script.length < 10) return showError('continue-error', 'Script must be at least 10 characters.');

  const btn = document.getElementById('continue-generate-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Splitting story...';

  try {
    const duration = parseInt(document.getElementById('continue-duration').value);
    const segments = await splitStoryWithStreaming(style, script, duration);
    if (!segments) throw new Error('Failed to split story');

    btn.textContent = '⏳ Starting...';
    const response = await apiFetch(`${API_BASE}/continue/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        style, script, duration,
        segmentDuration: FIXED_SEGMENT_DURATION,
        segments,
        initialFrameUrl: continueUploadedFrame.hostedUrl,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message);

    currentTasks['continue-story'] = data.taskId;
    document.getElementById('continue-sequence-panel').classList.remove('hidden');
    renderSequenceGrid(document.getElementById('continue-sequence-grid'), data.segments);
    document.getElementById('continue-export-btn').classList.remove('hidden');
    document.getElementById('continue-merge-btn').classList.remove('hidden');
    
    startTaskPolling('continue-story', data.taskId);
  } catch (error) {
    showError('continue-error', error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Continue Generation';
  }
});

// ============================================================
// TAB 4: GENERATE FROM SCENES
// ============================================================
let scenes = [];

document.getElementById('add-scene-btn').addEventListener('click', () => {
  scenes.push({ index: scenes.length, imageUrl: null, imagePath: null, prompt: '', videoUrl: null, status: 'pending' });
  renderScenesList();
});

function renderScenesList() {
  const list = document.getElementById('scenes-list');
  list.innerHTML = scenes.map((scene, i) => `
    <div class="scene-card" data-index="${i}">
      <div class="scene-header">
        <span class="scene-number">Scene ${i + 1}</span>
        <button class="btn-small remove-scene" data-index="${i}">🗑️</button>
      </div>
      <div class="scene-upload">
        ${scene.imageUrl 
          ? `<img src="${scene.imageUrl}" class="scene-preview-img">`
          : `<div class="scene-upload-zone" data-index="${i}">
               <div>📤 Click to upload image</div>
               <input type="file" accept="image/*" class="hidden scene-file-input" data-index="${i}">
             </div>`}
      </div>
      <textarea class="scene-prompt" data-index="${i}" rows="2" placeholder="Describe this scene..." ${!scene.imageUrl ? 'disabled' : ''}>${scene.prompt}</textarea>
    </div>
  `).join('');

  // Event listeners
  document.querySelectorAll('.remove-scene').forEach(btn => {
    btn.addEventListener('click', () => {
      scenes.splice(parseInt(btn.dataset.index), 1);
      scenes.forEach((s, i) => s.index = i);
      renderScenesList();
    });
  });

  document.querySelectorAll('.scene-upload-zone').forEach(zone => {
    zone.addEventListener('click', () => {
      zone.querySelector('.scene-file-input').click();
    });
  });

  document.querySelectorAll('.scene-file-input').forEach(input => {
    input.addEventListener('change', async (e) => {
      const index = parseInt(input.dataset.index);
      const file = e.target.files[0];
      if (!file) return;

      if (file.size > 10 * 1024 * 1024) {
        return showError('scenes-error', 'Image too large. Max 10MB.');
      }

      const formData = new FormData();
      formData.append('image', file);

      try {
        const response = await apiFetch(`${API_BASE}/scenes/upload`, { method: 'POST', body: formData });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);

        scenes[index].imageUrl = data.imageUrl;
        scenes[index].imagePath = data.imagePath;
        renderScenesList();
      } catch (error) {
        showError('scenes-error', error.message);
      }
    });
  });

  document.querySelectorAll('.scene-prompt').forEach(textarea => {
    textarea.addEventListener('change', () => {
      const index = parseInt(textarea.dataset.index);
      scenes[index].prompt = textarea.value;
    });
  });
}

document.getElementById('scenes-generate-btn').addEventListener('click', async () => {
  const validScenes = scenes.filter(s => s.imageUrl && s.prompt.trim().length >= 3);
  if (validScenes.length === 0) {
    return showError('scenes-error', 'Add at least one scene with image and prompt.');
  }

  const btn = document.getElementById('scenes-generate-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Starting...';

  try {
    const response = await apiFetch(`${API_BASE}/scenes/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenes: validScenes }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message);

    currentTasks['generate-scenes'] = data.taskId;
    document.getElementById('scenes-sequence-panel').classList.remove('hidden');
    renderSequenceGrid(document.getElementById('scenes-sequence-grid'), data.segments);
    document.getElementById('scenes-export-btn').classList.remove('hidden');
    document.getElementById('scenes-merge-btn').classList.remove('hidden');
    document.getElementById('scenes-stop-btn').classList.remove('hidden');
    
    startTaskPolling('generate-scenes', data.taskId);
  } catch (error) {
    showError('scenes-error', error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Generate All Scenes';
  }
});

document.getElementById('scenes-stop-btn').addEventListener('click', async () => {
  const taskId = currentTasks['generate-scenes'];
  if (!taskId) return;
  await apiFetch(`${API_BASE}/task/stop/${taskId}`, { method: 'POST' });
  document.getElementById('scenes-stop-btn').classList.add('hidden');
});

document.getElementById('scenes-export-btn').addEventListener('click', async () => {
  const taskId = currentTasks['generate-scenes'];
  if (!taskId) return;
  const res = await apiFetch(`${API_BASE}/task/export/${taskId}`, { method: 'POST' });
  const data = await res.json();
  if (data.success) window.open(data.videoUrl, '_blank');
  else showError('scenes-error', data.error);
});

document.getElementById('scenes-merge-btn').addEventListener('click', async () => {
  const taskId = currentTasks['generate-scenes'];
  if (!taskId) return;
  const res = await apiFetch(`${API_BASE}/task/merge/${taskId}`, { method: 'POST' });
  const data = await res.json();
  if (data.success) window.open(data.videoUrl, '_blank');
  else showError('scenes-error', data.error);
});

// Initialize with one scene
renderScenesList();

// ============================================================
// SHARED: SEQUENCE GRID RENDERING
// ============================================================
function renderSequenceGrid(gridElement, segments) {
  gridElement.innerHTML = segments.map((seg, i) => `
    <div class="segment-card ${seg.status}" data-index="${i}">
      <div class="segment-header">
        <div class="segment-number">${i + 1}</div>
        <div class="segment-status ${seg.status}">${seg.status}</div>
      </div>
      <div class="segment-prompt">${seg.prompt || 'No prompt'}</div>
      <video class="segment-video ${seg.videoUrl ? 'visible' : ''}" controls preload="metadata">
        ${seg.videoUrl ? `<source src="${seg.videoUrl}" type="video/mp4">` : ''}
      </video>
      <div class="segment-actions">
        <button class="btn-small regenerate-segment" data-index="${i}" ${seg.status === 'generating' ? 'disabled' : ''}>
          🔄 Regenerate
        </button>
      </div>
    </div>
  `).join('');

  gridElement.querySelectorAll('.regenerate-segment').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = parseInt(btn.dataset.index);
      const taskId = currentTasks[currentTab];
      if (!taskId) return;

      btn.disabled = true;
      btn.textContent = '⏳';

      // Scenes each carry their own seed image rather than chaining
      // the previous segment's extracted frame, so they need the
      // dedicated scenes-regenerate endpoint — the generic segment
      // regenerate endpoint would silently drop the scene's image.
      const endpoint = currentTab === 'generate-scenes'
        ? `${API_BASE}/scenes/regenerate/${taskId}/${index}`
        : `${API_BASE}/task/regenerate/${taskId}/${index}`;

      await apiFetch(endpoint, { method: 'POST' });
    });
  });
}

function updateSegmentCard(gridElement, index, segment) {
  const card = gridElement.querySelector(`.segment-card[data-index="${index}"]`);
  if (!card) return;

  card.className = `segment-card ${segment.status}`;
  const statusEl = card.querySelector('.segment-status');
  statusEl.className = `segment-status ${segment.status}`;
  statusEl.textContent = segment.status;

  if (segment.videoUrl) {
    const video = card.querySelector('.segment-video');
    video.classList.add('visible');
    video.innerHTML = `<source src="${segment.videoUrl}" type="video/mp4">`;
    video.load();
  }
}

// ============================================================
// SHARED: STREAMING STORY SPLIT
// ============================================================
async function splitStoryWithStreaming(style, script, duration) {
  const numSegments = Math.ceil(duration / FIXED_SEGMENT_DURATION);

  try {
    const response = await apiFetch(`${API_BASE}/story/split-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style, script, numSegments, segmentDuration: FIXED_SEGMENT_DURATION }),
    });

    // If the request never made it into the SSE stream (e.g. 401 from the
    // access-key gate, or a 400 validation error), the body is plain JSON,
    // not an event stream. Surface that instead of trying to read it as one.
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Missing or invalid access key. Open this app once with ?key=YOUR_APP_ACCESS_KEY in the URL to authenticate this browser, then reload.');
      }
      let message = `HTTP ${response.status}`;
      try {
        const errBody = await response.json();
        message = errBody.message || errBody.error || message;
      } catch (e) {}
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let segments = [];
    let streamError = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'complete') segments = data.segments;
            if (data.type === 'error') streamError = data.error;
          } catch (e) {}
        }
      }
    }

    // The endpoint hit an error (e.g. Qwen API auth/config failure) and sent
    // an 'error' SSE event instead of 'complete'. Surface the real reason
    // instead of silently returning an empty segment list.
    if (streamError) {
      throw new Error(streamError);
    }

    return segments;
  } catch (error) {
    showError('error-msg', `Failed to split story: ${error.message}`);
    return null;
  }
}

// ============================================================
// SHARED: TASK POLLING
// ============================================================
function startTaskPolling(tabName, taskId) {
  if (pollIntervals[tabName]) clearInterval(pollIntervals[tabName]);
  
  const gridElement = document.getElementById(
    tabName === 'new-story' ? 'sequence-grid' :
    tabName === 'continue-story' ? 'continue-sequence-grid' :
    'scenes-sequence-grid'
  );

  pollIntervals[tabName] = setInterval(async () => {
    try {
      const response = await apiFetch(`${API_BASE}/task/status/${taskId}`);
      const data = await response.json();

      if (data.segments) {
        data.segments.forEach((seg, i) => updateSegmentCard(gridElement, i, seg));
      }

      if (data.status === 'completed' || data.status === 'stopped' || data.status === 'failed') {
        clearInterval(pollIntervals[tabName]);
        
        if (tabName === 'new-story') {
          stopBtn.classList.add('hidden');
          mergeBtn.classList.remove('hidden');
          generateBtn.disabled = false;
          generateBtn.textContent = '🚀 Generate Animated Video';
        } else if (tabName === 'generate-scenes') {
          document.getElementById('scenes-stop-btn').classList.add('hidden');
        }

        if (data.status === 'failed') {
          const errorId = tabName === 'new-story' ? 'error-msg' :
                         tabName === 'continue-story' ? 'continue-error' : 'scenes-error';
          showError(errorId, data.error || 'Task failed');
        }
      }
    } catch (error) {
      console.error('Poll error:', error);
    }
  }, 3000);
}