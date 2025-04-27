const fs=require('fs');
const path=require('path');
const { safeStringify }=require('./errorHandler');
const { getCurrentConfig, getBlacklistStats, forceReloadConfig }=require('./blacklist');
const cacheManager=require('./cache');
const os=require('os');

// 黑名单配置文件路径
const blacklistConfigPath=path.join(process.cwd(),'data/blacklist.json');

// 日志文件目录
const logDir=path.join(process.cwd(),'logs');
// 确保日志目录存在
if(!fs.existsSync(logDir)){
  try{
    fs.mkdirSync(logDir,{recursive:true});
  }catch(err){
    console.error('创建日志目录失败:',err.message);
  }
}

// 访问日志路径
const accessLogPath=path.join(logDir,'access.log');
// 错误日志路径
const errorLogPath=path.join(logDir,'error.log');
// 黑名单拦截日志路径
const blockLogPath=path.join(logDir,'block.log');

// 性能指标收集
const performanceData = {
  startTime: Date.now(),
  requestsProcessed: 0,
  averageResponseTime: 0,
  totalResponseTime: 0,
  slowRequests: [], // 最慢的10个请求
  errors: 0,
  pathStats: {}, // 初始化 pathStats 对象
  repositoryStats: {} // 添加仓库统计对象
};

// 添加初始示例数据，方便用户理解数据格式
(function initSampleData() {
  // 初始化性能数据时不再添加示例数据
  console.log('初始化性能数据...');
})();

// 记录访问日志
const logAccess=(req,status=200)=>{
  const time=new Date().toISOString();
  const ip=req.headers['x-forwarded-for']||req.socket.remoteAddress;
  const ua=req.headers['user-agent']||'-';
  const method=req.method;
  const url=req.url;
  
  const logLine=`[${time}] ${ip} "${method} ${url}" ${status} "${ua}"\n`;
  
  fs.appendFile(accessLogPath,logLine,err=>{
    if(err)console.error('写入访问日志失败:',err.message);
  });
};

// 记录错误日志
const logError=(req,error)=>{
  const time=new Date().toISOString();
  const ip=req.headers['x-forwarded-for']||req.socket.remoteAddress;
  const method=req.method;
  const url=req.url;
  
  const logLine=`[${time}] ${ip} "${method} ${url}" ERROR: ${error.message}\n${error.stack||''}\n\n`;
  
  fs.appendFile(errorLogPath,logLine,err=>{
    if(err)console.error('写入错误日志失败:',err.message);
  });
};

// 记录黑名单拦截日志
const logBlocked=(req,repoPath)=>{
  const time=new Date().toISOString();
  const ip=req.headers['x-forwarded-for']||req.socket.remoteAddress;
  const ua=req.headers['user-agent']||'-';
  const url=req.url;
  
  const logLine=`[${time}] ${ip} "BLOCKED ${url}" REPO: ${repoPath} "${ua}"\n`;
  
  fs.appendFile(blockLogPath,logLine,err=>{
    if(err)console.error('写入拦截日志失败:',err.message);
  });
};

// 读取日志文件
const readLogFile = async (logFile, limit = 100) => {
  try {
    // 根据logFile参数确定文件路径
    let filePath;
    if (logFile === 'access') {
      filePath = accessLogPath;
    } else if (logFile === 'error') {
      filePath = errorLogPath;
    } else if (logFile === 'blocked') {
      filePath = blockLogPath;
    } else {
      return { error: '无效的日志类型' };
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return { logs: [], message: '日志文件不存在' };
    }
    
    // 读取文件
    const content = await fs.promises.readFile(filePath, 'utf8');
    
    // 分割为行并取最后的limit行
    const lines = content.split('\n').filter(line => line.trim() !== '');
    const limitedLines = lines.slice(-limit);
    
    return { 
      logs: limitedLines,
      total: lines.length,
      showing: limitedLines.length,
      file: logFile
    };
  } catch (error) {
    console.error(`读取日志文件失败:`, error);
    return { error: '读取日志文件失败', message: error.message };
  }
};

// 清除日志文件
const clearLogFile = async (logFile) => {
  try {
    // 根据logFile参数确定文件路径
    let filePath;
    if (logFile === 'access') {
      filePath = accessLogPath;
    } else if (logFile === 'error') {
      filePath = errorLogPath;
    } else if (logFile === 'blocked') {
      filePath = blockLogPath;
    } else {
      return { error: '无效的日志类型' };
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return { success: false, message: '日志文件不存在' };
    }
    
    // 清空文件
    await fs.promises.writeFile(filePath, '', 'utf8');
    
    return { 
      success: true, 
      message: '日志已清空',
      file: logFile
    };
  } catch (error) {
    console.error(`清除日志文件失败:`, error);
    return { error: '清除日志文件失败', message: error.message };
  }
};

// 获取所有日志文件
const getLogFiles = () => {
  try {
    // 确保日志文件夹存在
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // 检查标准日志文件是否存在，不存在则创建
    const logTypes = ['access', 'error', 'blocked'];
    const logFiles = [];
    
    for (const type of logTypes) {
      let filePath;
      if (type === 'access') {
        filePath = accessLogPath;
      } else if (type === 'error') {
        filePath = errorLogPath;
      } else if (type === 'blocked') {
        filePath = blockLogPath;
      }
      
      // 确保文件存在
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf8');
      }
      
      // 获取文件行数和大小
      const stats = fs.statSync(filePath);
      const lineCount = countFileLines(filePath);
      
      logFiles.push({
        type,
        path: filePath,
        size: formatBytes(stats.size),
        lines: lineCount,
        lastModified: stats.mtime.toISOString()
      });
    }
    
    return {
      logs: logFiles,
      logDirectory: logDir
    };
  } catch (error) {
    console.error('获取日志文件列表失败:', error);
    return { error: '获取日志文件列表失败', message: error.message };
  }
};

// 计算文件行数
const countFileLines=(filePath)=>{
  try{
    const content=fs.readFileSync(filePath,'utf8');
    return content.split('\n').filter(line=>line.trim()!=='').length;
  }catch(err){
    return 0;
  }
};

// 格式化字节大小
const formatBytes=(bytes)=>{
  if(bytes===0)return'0 B';
  const k=1024;
  const sizes=['B','KB','MB','GB','TB'];
  const i=Math.floor(Math.log(bytes)/Math.log(k));
  return parseFloat((bytes/Math.pow(k,i)).toFixed(2))+' '+sizes[i];
};

// 更新黑名单配置
const updateBlacklist = async (newBlacklist) => {
  try {
    // 确保更新有效
    if(!newBlacklist||typeof newBlacklist!=='object'){
      return{error:'无效的更新对象'};
    }
    
    // 获取当前配置
    const currentConfig=getCurrentConfig();
    
    // 应用更新
    const newConfig={...currentConfig};
    
    // 更新仓库列表
    if(Array.isArray(newBlacklist.repositories)){
      newConfig.repositories=newBlacklist.repositories;
    }
    
    // 更新关键词列表
    if(Array.isArray(newBlacklist.keywords)){
      newConfig.keywords=newBlacklist.keywords;
    }
    
    // 更新白名单
    if(Array.isArray(newBlacklist.whitelistRepositories)){
      newConfig.whitelistRepositories=newBlacklist.whitelistRepositories;
    }
    
    // 更新启用状态
    if(typeof newBlacklist.enabled==='boolean'){
      newConfig.enabled=newBlacklist.enabled;
    }
    
    // 更新日志记录状态
    if(typeof newBlacklist.logBlocked==='boolean'){
      newConfig.logBlocked=newBlacklist.logBlocked;
    }
    
    // 更新错误响应
    if(newBlacklist.errorResponse&&typeof newBlacklist.errorResponse==='object'){
      newConfig.errorResponse={...currentConfig.errorResponse,...newBlacklist.errorResponse};
    }
    
    // 确保data目录存在
    const configDir = path.dirname(blacklistConfigPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    // 生成配置文件内容 - 直接JSON格式
    const configContent = JSON.stringify(newConfig, null, 2);
    
    // 写入文件
    try {
      fs.writeFileSync(blacklistConfigPath, configContent, 'utf8');
    } catch (writeErr) {
      console.error('写入黑名单配置文件失败:', writeErr);
      return {error: '写入配置文件失败', message: writeErr.message || '文件写入权限或路径错误'};
    }
    
    // 重新加载配置
    try {
      forceReloadConfig();
    } catch (reloadErr) {
      console.error('重新加载黑名单配置失败:', reloadErr);
      return {error: '重新加载配置失败', message: reloadErr.message || '配置格式可能有误'};
    }
    
    return{
      success:true,
      message:'黑名单配置已更新',
      timestamp:new Date().toISOString()
    };
  }catch(err){
    console.error('更新黑名单配置失败:', err);
    return{error:'更新黑名单配置失败',message:err.message || '未知错误'};
  }
};

// 添加黑名单条目
const addBlacklistEntry = async (entry) => {
  try {
    // 验证参数
    if(!entry||typeof entry!=='object'){
      return{error:'无效的参数'};
    }
    
    if(!entry.type || !entry.value) {
      return{error:'缺少必要的参数: type和value'};
    }
    
    console.log(`正在添加黑名单条目: ${entry.type} - ${entry.value}`);
    
    // 获取当前配置
    const currentConfig=getCurrentConfig();
    
    // 根据类型添加到相应列表
    switch(entry.type){
      case'repository':
        // 检查是否已存在
        if(currentConfig.repositories.includes(entry.value)){
          return{error:'仓库已存在于黑名单中'};
        }
        currentConfig.repositories.push(entry.value);
        break;
      case'keyword':
        // 检查是否已存在
        if(currentConfig.keywords.includes(entry.value)){
          return{error:'关键词已存在于黑名单中'};
        }
        currentConfig.keywords.push(entry.value);
        break;
      case'whitelist':
        // 检查是否已存在
        if(currentConfig.whitelistRepositories.includes(entry.value)){
          return{error:'仓库已存在于白名单中'};
        }
        currentConfig.whitelistRepositories.push(entry.value);
        break;
      default:
        return{error:'无效的黑名单类型'};
    }
    
    // 更新配置
    return updateBlacklist(currentConfig);
  }catch(err){
    console.error('添加黑名单条目失败:', err);
    return{error:'添加黑名单条目失败',message:err.message || '未知错误'};
  }
};

// 移除黑名单条目
const removeBlacklistEntry = async (entry) => {
  try {
    // 验证参数
    if(!entry||typeof entry!=='object'){
      return{error:'无效的参数'};
    }
    
    // 获取当前配置
    const currentConfig=getCurrentConfig();
    
    // 根据类型从相应列表删除
    switch(entry.type){
      case'repository':
        currentConfig.repositories=currentConfig.repositories.filter(r=>r!==entry.value);
        break;
      case'keyword':
        currentConfig.keywords=currentConfig.keywords.filter(k=>k!==entry.value);
        break;
      case'whitelist':
        currentConfig.whitelistRepositories=currentConfig.whitelistRepositories.filter(r=>r!==entry.value);
        break;
      default:
        return{error:'无效的黑名单类型'};
    }
    
    // 更新配置
    return updateBlacklist(currentConfig);
  }catch(err){
    return{error:'删除黑名单条目失败',message:err.message};
  }
};

// 导出黑名单
const exportBlacklist = async () => {
  try {
    const config=getCurrentConfig();
    return{
      data:config,
      timestamp:new Date().toISOString(),
      format:'json'
    };
  }catch(err){
    return{error:'导出黑名单配置失败',message:err.message};
  }
};

// 导入黑名单
const importBlacklist = async (configData) => {
  try {
    // 验证导入的数据
    if(!configData||typeof configData!=='object'){
      return{error:'无效的配置数据'};
    }
    
    // 确保必要的字段存在
    const requiredFields=['repositories','keywords','whitelistRepositories'];
    for(const field of requiredFields){
      if(!Array.isArray(configData[field])){
        return{error:`导入数据缺少必要字段: ${field}`};
      }
    }
    
    // 更新配置
    return updateBlacklist(configData);
  }catch(err){
    return{error:'导入黑名单配置失败',message:err.message};
  }
};

// 格式化CPU使用率
const formatCpuUsage = (cpuUsage) => {
  return `${(cpuUsage * 100).toFixed(2)}%`;
};

// 格式化文件大小
const formatSize = (size) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let formattedSize = size;

  while (formattedSize >= 1024 && index < units.length - 1) {
    formattedSize /= 1024;
    index++;
  }

  return `${formattedSize.toFixed(2)} ${units[index]}`;
};

// 格式化持续时间
const formatDuration = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(2)}min`;
  return `${(ms / 3600000).toFixed(2)}h`;
};

// 记录性能数据点
const recordPerformanceDataPoint = (path, responseTime, statusCode, size) => {
  try {
    // 确保参数有效
    if (typeof path !== 'string') path = String(path || '');
    if (typeof responseTime !== 'number' || isNaN(responseTime)) responseTime = 0;
    if (typeof statusCode !== 'number' || isNaN(statusCode)) statusCode = 200;
    if (typeof size !== 'number' || isNaN(size)) size = 0;
    
    // 确保performanceData的基本属性已初始化
    if (!performanceData || typeof performanceData !== 'object') {
      console.error('性能数据对象不存在或无效，重新初始化');
      performanceData = {
        startTime: Date.now(),
        requestsProcessed: 0,
        averageResponseTime: 0,
        totalResponseTime: 0,
        slowRequests: [],
        errors: 0,
        pathStats: {},
        repositoryStats: {}
      };
    }
    
    if (typeof performanceData.requestsProcessed !== 'number') performanceData.requestsProcessed = 0;
    if (typeof performanceData.totalResponseTime !== 'number') performanceData.totalResponseTime = 0;
    if (typeof performanceData.averageResponseTime !== 'number') performanceData.averageResponseTime = 0;
    if (!Array.isArray(performanceData.slowRequests)) performanceData.slowRequests = [];
    if (typeof performanceData.errors !== 'number') performanceData.errors = 0;
    if (!performanceData.pathStats || typeof performanceData.pathStats !== 'object') performanceData.pathStats = {};
    if (!performanceData.repositoryStats || typeof performanceData.repositoryStats !== 'object') performanceData.repositoryStats = {};

    // 更新基本统计信息
    performanceData.requestsProcessed++;
    
    // 更新平均响应时间
    performanceData.totalResponseTime += responseTime;
    performanceData.averageResponseTime = performanceData.totalResponseTime / performanceData.requestsProcessed;
    
    // 记录慢请求
    if (responseTime > 1000) {
      performanceData.slowRequests.push({
        path,
        responseTime,
        timestamp: new Date().toISOString()
      });
      // 保持数组在限定大小内
      if (performanceData.slowRequests.length > 100) {
        performanceData.slowRequests.shift();
      }
    }

    // 记录错误
    if (statusCode >= 400) {
      performanceData.errors++;
    }

    // 更新路径统计
    try {
      if (!performanceData.pathStats[path]) {
        performanceData.pathStats[path] = {
          requestsCount: 0,
          totalResponseTime: 0,
          averageResponseTime: 0,
          totalSize: 0,
          averageSize: 0
        };
      }
      
      // 尝试从路径中提取仓库信息
      const repoMatch = path.match(/\/([^\/]+\/[^\/]+)(\/|$)/);
      if (repoMatch && repoMatch[1]) {
        const repoPath = repoMatch[1];
        // 排除非仓库路径
        if (!repoPath.includes('.') && !repoPath.includes('admin') && repoPath.includes('/')) {
          if (!performanceData.repositoryStats[repoPath]) {
            performanceData.repositoryStats[repoPath] = {
              requestsCount: 0,
              totalResponseTime: 0,
              averageResponseTime: 0
            };
          }
          
          // 确保仓库统计对象有效
          if (typeof performanceData.repositoryStats[repoPath] !== 'object') {
            performanceData.repositoryStats[repoPath] = {
              requestsCount: 0,
              totalResponseTime: 0,
              averageResponseTime: 0
            };
          }
          
          // 更新仓库统计
          const repoStat = performanceData.repositoryStats[repoPath];
          repoStat.requestsCount = (repoStat.requestsCount || 0) + 1;
          repoStat.totalResponseTime = (repoStat.totalResponseTime || 0) + responseTime;
          repoStat.averageResponseTime = repoStat.totalResponseTime / repoStat.requestsCount;
        }
      }
      
      // 更新路径统计
      const pathStat = performanceData.pathStats[path];
      if (pathStat && typeof pathStat === 'object') {
        pathStat.requestsCount = (pathStat.requestsCount || 0) + 1;
        pathStat.totalResponseTime = (pathStat.totalResponseTime || 0) + responseTime;
        pathStat.averageResponseTime = pathStat.totalResponseTime / pathStat.requestsCount;
        pathStat.totalSize = (pathStat.totalSize || 0) + size;
        pathStat.averageSize = pathStat.totalSize / pathStat.requestsCount;
      }
    } catch (err) {
      console.error('更新统计数据失败:', err.message, err.stack);
    }
  } catch (error) {
    console.error('记录性能数据点失败:', error.message, error.stack);
  }
};

// 获取性能指标
const getPerformanceMetrics = async () => {
  // 获取系统信息
  const os = require('os');
  const startTime = process.uptime();
  const memory = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  
  // 计算CPU使用率
  const cpuPercent = cpuUsage.user / (cpuUsage.user + cpuUsage.system) || 0;
  
  // 不再强制添加示例数据
  if (!performanceData.repositoryStats || 
      typeof performanceData.repositoryStats !== 'object') {
    performanceData.repositoryStats = {};
  }
  
  // 处理仓库统计数据 - 按请求量排序
  const repoStats = performanceData.repositoryStats || {};
  
  // 确保仓库统计是有效的对象
  let sortedRepoStats = [];
  
  try {
    if (repoStats && typeof repoStats === 'object') {
      sortedRepoStats = Object.entries(repoStats)
        .map(([repo, stats]) => ({
          repository: repo,
          requestsCount: stats && typeof stats === 'object' ? (stats.requestsCount || 0) : 0,
          averageResponseTime: stats && typeof stats === 'object' ? 
            (typeof stats.averageResponseTime === 'string' ? 
              stats.averageResponseTime : 
              formatDuration(stats.averageResponseTime || 0)) : '0ms'
        }))
        .sort((a, b) => b.requestsCount - a.requestsCount)
        .slice(0, 20); // 仅返回前20个最热门仓库
    }
  } catch (error) {
    console.error('转换仓库统计失败:', error);
    // 失败时提供空数组
    sortedRepoStats = [];
  }
  
  // 确保所有数据都有默认值，防止空对象导致前端错误
  const result = {
    uptime: formatDuration(startTime * 1000),
    memory: {
      rss: formatSize(memory.rss),
      heapTotal: formatSize(memory.heapTotal),
      heapUsed: formatSize(memory.heapUsed)
    },
    cpu: formatCpuUsage(cpuPercent),
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      loadAvg: os.loadavg()
    },
    requestsProcessed: performanceData.requestsProcessed || 0,
    averageResponseTime: formatDuration(performanceData.averageResponseTime || 0),
    slowRequests: performanceData.slowRequests || [],
    errors: performanceData.errors || 0,
    pathStats: performanceData.pathStats 
      ? Object.entries(performanceData.pathStats).map(([path, stats]) => ({
          path,
          requestsCount: stats.requestsCount || 0,
          averageResponseTime: formatDuration(stats.averageResponseTime || 0),
          averageSize: formatSize(stats.averageSize || 0)
        })) 
      : [],
    repositoryStats: sortedRepoStats // 保证这是一个数组，即使是空数组
  };
  
  // 确保返回结果不会被序列化丢失数据
  try {
    // 测试能否正确序列化
    const testJson = JSON.stringify(result);
    if (!testJson || testJson === '{}' || testJson === '[]') {
      console.error('序列化结果异常:', testJson);
      // 返回基本数据结构，确保前端至少能收到数据
      return {
        uptime: formatDuration(startTime * 1000),
        requestsProcessed: performanceData.requestsProcessed || 0,
        averageResponseTime: formatDuration(performanceData.averageResponseTime || 0),
        repositoryStats: sortedRepoStats || [],
        errors: performanceData.errors || 0
      };
    }
  } catch (err) {
    console.error('序列化性能数据失败:', err);
    // 返回简单数据结构
    return {
      error: '数据序列化失败',
      repositoryStats: []
    };
  }
  
  return result;
};

// 为性能数据收集注册钩子
process.on('exit', () => {
  try {
    // 保存性能数据
    const perfLogPath = path.join(logDir, 'performance.log');
    fs.appendFileSync(perfLogPath, `${new Date().toISOString()} | 服务结束 | 处理请求: ${performanceData.requestsProcessed} | 平均响应时间: ${performanceData.averageResponseTime.toFixed(2)}ms\n`);
  } catch (err) {
    console.error('保存性能日志失败:', err.message);
  }
});

// 格式化运行时间
const formatUptime=(seconds)=>{
  const days=Math.floor(seconds/86400);
  const hours=Math.floor((seconds%86400)/3600);
  const minutes=Math.floor((seconds%3600)/60);
  const secs=Math.floor(seconds%60);
  
  return`${days}天 ${hours}小时 ${minutes}分钟 ${secs}秒`;
};

// 重置性能数据
const resetPerformanceData = () => {
  performanceData.startTime = Date.now();
  performanceData.requestsProcessed = 0;
  performanceData.averageResponseTime = 0;
  performanceData.totalResponseTime = 0;
  performanceData.slowRequests = [];
  performanceData.errors = 0;
  performanceData.pathStats = {};
  performanceData.repositoryStats = {};
  
  // 不再添加示例数据
  console.log('性能数据已重置');
  
  return {
    success: true,
    message: '性能数据已重置',
    timestamp: new Date().toISOString()
  };
};

module.exports={
  logAccess,
  logError,
  logBlocked,
  readLogFile,
  clearLogFile,
  getLogFiles,
  updateBlacklist,
  addBlacklistEntry,
  removeBlacklistEntry,
  exportBlacklist,
  importBlacklist,
  getPerformanceMetrics,
  recordPerformanceDataPoint,
  resetPerformanceData
}; 