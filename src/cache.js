const config = require('../config/config');
const { EventEmitter } = require('events');
const { safeStringify } = require('./errorHandler');

class CacheManager extends EventEmitter {
  constructor() {
    super();
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      size: 0
    };
    
    // 定期清理过期缓存
    setInterval(() => this.cleanup(), 10 * 60 * 1000); // 每10分钟清理一次
  }
  
  // 获取缓存数据
  get(key) {
    if (!config.cache.enabled) return null;
    
    const item = this.cache.get(key);
    if (!item) {
      this.stats.misses++;
      return null;
    }
    
    // 检查是否过期
    if (Date.now() - item.timestamp > item.maxAge) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }
    
    this.stats.hits++;
    return item.data;
  }
  
  // 设置缓存数据
  set(key, data, maxAge) {
    if (!config.cache.enabled) return;
    
    try {
      // 保护不可缓存的数据类型(例如流)
      if (data instanceof EventEmitter ||
          (typeof data === 'object' && data !== null && (data.pipe || data.on))) {
        console.warn(`警告: 尝试缓存不可序列化的对象类型: ${key}`);
        return;
      }
      
      const item = {
        data,
        timestamp: Date.now(),
        maxAge: maxAge || config.cache.maxAge
      };
      
      // 如果数据已经存在，减去旧的数据大小
      if (this.cache.has(key)) {
        const oldSize = this._estimateSize(this.cache.get(key).data);
        this.stats.size -= oldSize;
      }
      
      this.cache.set(key, item);
      this.stats.size += this._estimateSize(data);
      
      // 触发缓存更新事件
      this.emit('update', { key, size: this.stats.size });
    } catch (err) {
      console.error(`缓存设置错误 (${key}):`, err.message);
    }
  }
  
  // 清理过期缓存
  cleanup() {
    try {
      const now = Date.now();
      let removed = 0;
      let freedSize = 0;
      
      for (const [key, item] of this.cache.entries()) {
        if (now - item.timestamp > item.maxAge) {
          freedSize += this._estimateSize(item.data);
          this.cache.delete(key);
          removed++;
        }
      }
      
      this.stats.size -= freedSize;
      
      if (removed > 0) {
        console.log(`缓存清理完成: 移除了 ${removed} 项过期缓存，释放约 ${(freedSize / 1024 / 1024).toFixed(2)} MB 内存`);
        this.emit('cleanup', { removed, freedSize });
      }
    } catch (err) {
      console.error('缓存清理错误:', err.message);
    }
  }
  
  // 强制清空所有缓存
  clear() {
    try {
      const size = this.stats.size;
      const count = this.cache.size;
      
      this.cache.clear();
      this.stats.size = 0;
      
      console.log(`缓存已清空: 移除了 ${count} 项缓存，释放约 ${(size / 1024 / 1024).toFixed(2)} MB 内存`);
      this.emit('clear', { count, size });
      
      return { count, size };
    } catch (err) {
      console.error('缓存清空错误:', err.message);
      return { error: err.message };
    }
  }
  
  // 获取缓存统计信息
  getStats() {
    const stats = {
      ...this.stats,
      count: this.cache.size,
      hitRate: this.stats.hits + this.stats.misses > 0
        ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2) + '%'
        : '0%',
      sizeInMB: (this.stats.size / 1024 / 1024).toFixed(2) + ' MB'
    };
    
    // 添加热点键信息
    if (this.cache.size > 0) {
      try {
        const hotKeys = Array.from(this.cache.keys())
          .sort((a, b) => this._estimateSize(this.cache.get(b).data) - this._estimateSize(this.cache.get(a).data))
          .slice(0, 5)
          .map(key => ({
            key: key.length > 50 ? key.substring(0, 47) + '...' : key,
            size: formatBytes(this._estimateSize(this.cache.get(key).data)),
            age: formatTimeAgo(Date.now() - this.cache.get(key).timestamp)
          }));
        stats.hotKeys = hotKeys;
      } catch (e) {
        stats.hotKeys = [{ error: '无法获取热点键信息' }];
      }
    }
    
    return stats;
  }
  
  // 估算数据大小(粗略估计)
  _estimateSize(data) {
    try {
      if (Buffer.isBuffer(data)) {
        return data.length;
      } else if (typeof data === 'string') {
        return Buffer.byteLength(data, 'utf8');
      } else if (typeof data === 'object' && data !== null) {
        return Buffer.byteLength(safeStringify(data), 'utf8');
      }
      return 0;
    } catch (e) {
      console.error('数据大小估算错误:', e.message);
      return 100; // 使用默认小值
    }
  }
  
  // 格式化字节
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  // 格式化时间差
  formatTimeAgo(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
    return `${Math.floor(seconds / 86400)}天前`;
  }
}

module.exports = new CacheManager(); 