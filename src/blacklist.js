const fs=require('fs');
const path=require('path');

// 配置文件路径
const blacklistConfigPath=path.join(process.cwd(),'data/blacklist.json');

// 获取配置文件最后修改时间
let configLastModified=0;

// 默认配置
const defaultConfig = {
  enabled: false,
  repositories: [],
  keywords: [],
  whitelistRepositories: [],
  logBlocked: true,
  errorResponse: {
    statusCode: 451,
    message: "根据相关法律法规，该内容不予显示"
  }
};

// 动态加载黑名单配置
let blacklistConfig = defaultConfig;

// 缓存已经检查过的路径结果
const checkedPathsCache=new Map();

// 清除配置缓存并重新加载
const reloadConfig=()=>{
  try{
    // 确保data目录存在
    const dataDir = path.dirname(blacklistConfigPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // 检查配置文件是否存在
    if (!fs.existsSync(blacklistConfigPath)) {
      console.log(`[${new Date().toISOString()}] 黑名单配置文件不存在: ${blacklistConfigPath}`);
      
      // 写入默认配置
      fs.writeFileSync(blacklistConfigPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
      console.log(`[${new Date().toISOString()}] 已创建默认黑名单配置文件: ${blacklistConfigPath}`);
    }
    
    // 读取JSON配置文件
    const configData = fs.readFileSync(blacklistConfigPath, 'utf8');
    blacklistConfig = JSON.parse(configData);
    
    // 清空路径检查缓存
    checkedPathsCache.clear();
    // 更新最后修改时间
    configLastModified=fs.statSync(blacklistConfigPath).mtimeMs;
    console.log(`[${new Date().toISOString()}] 黑名单配置已热更新，缓存已清空`);
    return true;
  }catch(err){
    console.error('重新加载黑名单配置失败:',err.message);
    // 如果加载失败，使用默认配置
    blacklistConfig = {...defaultConfig};
    return false;
  }
};

// 检查配置文件是否更新
const checkConfigUpdated=()=>{
  try{
    // 如果文件不存在，尝试创建
    if (!fs.existsSync(blacklistConfigPath)) {
      return reloadConfig();
    }
    
    const stats=fs.statSync(blacklistConfigPath);
    if(stats.mtimeMs>configLastModified){
      return reloadConfig();
    }
    return false;
  }catch(err){
    console.error('检查配置文件更新失败:',err.message);
    return false;
  }
};

// 初始化配置
reloadConfig();

// 定时检查配置文件更新(每30秒)
const configCheckInterval=30*1000;
setInterval(checkConfigUpdated,configCheckInterval);

// 从URL路径中提取仓库路径
const extractRepoPath=(urlPath)=>{
  // 检查配置是否有更新
  checkConfigUpdated();
  
  // 跳过基本路径如/api, /raw等
  if(urlPath.startsWith('/api/')||
     urlPath.startsWith('/raw/')||
     urlPath.startsWith('/assets/')||
     urlPath.startsWith('/releases/')||
     urlPath.startsWith('/codeload/')||
     urlPath.startsWith('/admin/')){
    return null;
  }
  
  // 分割路径
  const parts=urlPath.split('/').filter(p=>p.length>0);
  
  // 需要至少有owner/repo两部分
  if(parts.length<2)return null;
  
  // 返回owner/repo格式
  return`${parts[0]}/${parts[1]}`.toLowerCase();
};

// 检查仓库是否在黑名单中
const isRepoBlacklisted=(repoPath)=>{
  if(!repoPath||!blacklistConfig.enabled)return false;
  
  // 检查缓存
  if(checkedPathsCache.has(repoPath)){
    return checkedPathsCache.get(repoPath);
  }
  
  // 转为小写以进行不区分大小写的比较
  const lowerRepoPath=repoPath.toLowerCase();
  
  // 检查白名单
  if(blacklistConfig.whitelistRepositories.some(r=>
    r.toLowerCase()===lowerRepoPath
  )){
    checkedPathsCache.set(repoPath,false);
    return false;
  }
  
  // 检查完全匹配的仓库
  if(blacklistConfig.repositories.some(r=>
    r.toLowerCase()===lowerRepoPath
  )){
    checkedPathsCache.set(repoPath,true);
    return true;
  }
  
  // 检查关键词匹配
  const isBlocked=blacklistConfig.keywords.some(keyword=>
    lowerRepoPath.includes(keyword.toLowerCase())
  );
  
  // 缓存结果
  checkedPathsCache.set(repoPath,isBlocked);
  return isBlocked;
};

// 检查URL路径是否应该被拦截
const shouldBlockPath=(urlPath)=>{
  if(!blacklistConfig.enabled)return false;
  
  const repoPath=extractRepoPath(urlPath);
  if(!repoPath)return false;
  
  return isRepoBlacklisted(repoPath);
};

// 记录被拦截的访问
const logBlockedAccess=(req,repoPath)=>{
  if(!blacklistConfig.logBlocked)return;
  
  const clientIP=req.headers['x-forwarded-for']||
                 req.socket.remoteAddress||
                 '未知IP';
  
  const timestamp=new Date().toISOString();
  const userAgent=req.headers['user-agent']||'未知客户端';
  
  console.log(`[${timestamp}] 拦截访问: ${repoPath} | IP: ${clientIP} | UA: ${userAgent}`);
  
  // 可以在此添加更详细的日志记录，如写入文件等
};

// 创建自定义451状态响应
const createBlockedResponse=(repoPath='')=>{
  const statusCode=blacklistConfig.errorResponse.statusCode||451;
  const message=blacklistConfig.errorResponse.message||'根据相关法律法规，该内容不予显示';
  
  try {
    // 尝试使用自定义错误页面
    const customPagePath = path.join(process.cwd(), 'public/451.html');
    const customPageExists = fs.existsSync(customPagePath);
    
    if (customPageExists) {
      const content = fs.readFileSync(customPagePath, 'utf-8');
      return {
        statusCode,
        headers:{
          'Content-Type':'text/html; charset=utf-8',
          'Cache-Control':'no-store, no-cache, must-revalidate'
        },
        body: content
      };
    }
  } catch (err) {
    console.error('读取自定义451页面失败:', err.message);
  }
  
  // 使用默认内联模板
  return{
    statusCode,
    headers:{
      'Content-Type':'text/html; charset=utf-8',
      'Cache-Control':'no-store, no-cache, must-revalidate'
    },
    body:`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>内容不可用</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:20px;background:#f5f5f5;color:#333;line-height:1.5}
    .container{max-width:800px;margin:50px auto;padding:30px;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.05);text-align:center}
    h1{font-size:24px;margin-bottom:20px;color:#d33}
    p{margin:15px 0}
    .code{font-size:42px;color:#d33;margin:10px 0}
    .back{display:inline-block;margin-top:20px;padding:10px 20px;background:#f5f5f5;color:#333;text-decoration:none;border-radius:4px}
    .back:hover{background:#eee}
  </style>
</head>
<body>
  <div class="container">
    <div class="code">451</div>
    <h1>内容因法律原因不可用</h1>
    <p>${message}</p>
    <a href="/" class="back">返回首页</a>
  </div>
</body>
</html>`
  };
};

// 中间件：检查并阻止访问黑名单内容
const blockBlacklistedContent=(req,res,next)=>{
  if(!blacklistConfig.enabled){
    next();
    return false;
  }
  
  const urlPath=req.url;
  const repoPath=extractRepoPath(urlPath);
  
  if(repoPath&&isRepoBlacklisted(repoPath)){
    logBlockedAccess(req,repoPath);
    
    const blockedResponse=createBlockedResponse(repoPath);
    res.writeHead(blockedResponse.statusCode,blockedResponse.headers);
    res.end(blockedResponse.body);
    return true;
  }
  
  next();
  return false;
};

// 手动触发黑名单配置重新加载
const forceReloadConfig=()=>{
  return reloadConfig();
};

// 获取当前黑名单配置
const getCurrentConfig=()=>{
  try {
    // 检查更新
    checkConfigUpdated();
    
    // 如果blacklistConfig为undefined或null，尝试重新加载
    if (!blacklistConfig) {
      console.log(`[${new Date().toISOString()}] 黑名单配置为空，尝试重新加载`);
      reloadConfig();
      
      // 如果仍为空，返回默认配置
      if (!blacklistConfig) {
        console.error(`[${new Date().toISOString()}] 无法加载黑名单配置，返回默认配置`);
        return {...defaultConfig};
      }
    }
    
    // 返回配置的深拷贝，防止外部修改
    return JSON.parse(JSON.stringify(blacklistConfig));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] 获取当前黑名单配置失败:`, err);
    // 返回默认配置
    return {...defaultConfig};
  }
};

// 获取黑名单统计信息
const getBlacklistStats=()=>{
  return{
    enabled:blacklistConfig.enabled,
    repositoriesCount:blacklistConfig.repositories.length,
    keywordsCount:blacklistConfig.keywords.length,
    whitelistCount:blacklistConfig.whitelistRepositories.length,
    cachedPathsCount:checkedPathsCache.size,
    configLastModified:new Date(configLastModified).toISOString(),
    logBlocked:blacklistConfig.logBlocked
  };
};

module.exports={
  shouldBlockPath,
  isRepoBlacklisted,
  blockBlacklistedContent,
  createBlockedResponse,
  extractRepoPath,
  forceReloadConfig,
  getCurrentConfig,
  getBlacklistStats
}; 