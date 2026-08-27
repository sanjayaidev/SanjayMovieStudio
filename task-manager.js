// task-manager.js - JSON-based task state management
const fs = require('fs');
const path = require('path');

const TASKS_DIR = path.join(__dirname, 'tasks');

// Ensure tasks directory exists
if (!fs.existsSync(TASKS_DIR)) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

class TaskManager {
  constructor() {
    this.tasks = new Map();
    this.loadAllTasks();
  }

  loadAllTasks() {
    const MAX_TASK_FILE_BYTES = 5 * 1024 * 1024; // 5MB — a well-formed task JSON should never approach this
    let skipped = 0;

    try {
      const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
      console.log(`📂 Found ${files.length} task file(s) in ${TASKS_DIR}, loading...`);

      files.forEach(file => {
        const filePath = path.join(TASKS_DIR, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.size > MAX_TASK_FILE_BYTES) {
            console.error(`⚠️ Skipping oversized task file ${file} (${(stats.size / 1024 / 1024).toFixed(1)}MB) — likely corrupt, not loading into memory. Delete or inspect it manually.`);
            skipped++;
            return;
          }

          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          this.tasks.set(data.id, data);
        } catch (err) {
          console.error(`Failed to load task ${file}:`, err.message);
        }
      });
      console.log(`✅ Loaded ${this.tasks.size} tasks from disk${skipped ? ` (${skipped} skipped as oversized)` : ''}`);
    } catch (err) {
      console.error('Failed to load tasks:', err.message);
    }
  }

  createTask(taskData) {
    const task = {
      id: taskData.id,
      type: taskData.type || 'new-story', // new-story | continue-story | generate-scenes
      status: 'initializing', // initializing | generating | stopped | completed | failed
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: taskData.metadata || {},
      segments: taskData.segments || [],
      finalVideoPath: null,
      error: null,
    };

    this.tasks.set(task.id, task);
    this.saveTask(task.id);
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    Object.assign(task, updates);
    task.updatedAt = new Date().toISOString();
    this.tasks.set(taskId, task);
    this.saveTask(taskId);
    return task;
  }

  updateSegment(taskId, segmentIndex, updates) {
    const task = this.tasks.get(taskId);
    if (!task || !task.segments[segmentIndex]) return null;

    Object.assign(task.segments[segmentIndex], updates);
    task.updatedAt = new Date().toISOString();
    this.saveTask(taskId);
    return task.segments[segmentIndex];
  }

  saveTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const filePath = path.join(TASKS_DIR, `${taskId}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
    } catch (err) {
      console.error(`Failed to save task ${taskId}:`, err.message);
    }
  }

  deleteTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Delete task files
    const filePath = path.join(TASKS_DIR, `${taskId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete associated video/frame files
    if (task.segments) {
      task.segments.forEach(seg => {
        if (seg.videoPath && fs.existsSync(seg.videoPath)) {
          fs.unlinkSync(seg.videoPath);
        }
        if (seg.framePath && fs.existsSync(seg.framePath)) {
          fs.unlinkSync(seg.framePath);
        }
        if (seg.versions) {
          seg.versions.forEach(v => {
            if (fs.existsSync(v)) fs.unlinkSync(v);
          });
        }
      });
    }

    if (task.finalVideoPath && fs.existsSync(task.finalVideoPath)) {
      fs.unlinkSync(task.finalVideoPath);
    }

    this.tasks.delete(taskId);
    return true;
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  getTasksByType(type) {
    return this.getAllTasks().filter(t => t.type === type);
  }

  /**
   * Delete tasks (and their files) older than maxAgeHours that are in a
   * terminal state (completed/failed/stopped). Keeps in-flight tasks
   * ('initializing'/'generating') untouched regardless of age.
   * Returns the number of tasks removed.
   */
  cleanupOldTasks(maxAgeHours = 24) {
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    const terminalStatuses = ['completed', 'failed', 'stopped'];
    let removed = 0;

    for (const task of this.getAllTasks()) {
      if (!terminalStatuses.includes(task.status)) continue;
      const updatedAt = new Date(task.updatedAt || task.createdAt).getTime();
      if (updatedAt < cutoff) {
        this.deleteTask(task.id);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`🧹 Cleaned up ${removed} old task(s) (older than ${maxAgeHours}h)`);
    }
    return removed;
  }
}

module.exports = new TaskManager();