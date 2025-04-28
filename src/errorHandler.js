const fs=require('fs');
const path=require('path');
const config=require('../config/config');
const axios=require('axios');

// 安全地将任何对象转换为JSON字符串，避免循环引用问题
const safeStringify=(obj)=>{
  try{
    const seen=new WeakSet();
    return JSON.stringify(obj,(k,v)=>typeof v==='object'&&v!==null?(seen.has(v)?'[循环引用]':(seen.add(v),v)):v);
  }catch(e){
    return JSON.stringify({error:'无法序列化对象',message:e.message});
  }
};

// 获取错误的安全表示，处理各种错误类型
const getSafeError=(error)=>{
  // 如果已经是字符串，直接返回
  if(typeof error==='string')return{message:error};
  
  // 为了防止循环引用，手动提取有用信息
  const safeError={
    message:error.message||'未知错误',
    name:error.name,
    code:error.code,
    status:error.status||error.statusCode
  };
  
  // 处理axios错误特殊属性
  if(error.response){
    safeError.response={
      status:error.response.status,
      statusText:error.response.statusText,
      headers:error.response.headers?{...error.response.headers}:undefined
    };
  }
  
  return safeError;
};

// 错误响应助手函数
const sendErrorResponse=(res,status,message,contentType='application/json')=>{
  // 确保不重复发送响应
  if(res.headersSent)return;
  
  res.statusCode=status||500;
  if(contentType==='application/json'){
    res.setHeader('Content-Type','application/json; charset=utf-8');
    // 使用安全的方式发送错误
    const errorObj=typeof message==='string'?{error:message}:message;
    res.end(safeStringify(errorObj));
  }else{
    res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.end(typeof message==='string'?message:safeStringify(message));
  }
};

// 处理各种错误类型
const handleError=(error,req,res)=>{
  if(res.headersSent)return; // 防止重复发送响应
  
  // 安全记录错误
  const safeError=getSafeError(error);
  console.error(`处理请求 ${req.url} 时出错:`,safeError.message);
  
  // 检查是否有响应状态码
  const status=error.response?.status||error.status||500;
  
  // 检查是否是CSP相关错误
  if(safeError.message.includes('Content Security Policy')||safeError.message.includes('CSP')){
    // 对CSP错误，返回更友好的响应
    sendErrorResponse(res,400,{
      error:'内容安全策略错误',
      message:'访问被CSP限制，请查看控制台获取详细信息',
      url:req.url
    });
    return;
  }
  
  // 检查是否涉及CDN域名
  if(req.url.includes('cdn.gh.squarefield.ltd')||
     (safeError.message&&safeError.message.includes('cdn.gh.squarefield.ltd'))){
    // 尝试通过代理路径重新请求
    console.log('检测到CDN请求失败，尝试通过代理路径重新请求');
    const redirectUrl=`/fragment${req.url.replace(/^\/fragment/, '')}`;
    res.writeHead(302,{
      'Location':redirectUrl,
      'Cache-Control':'no-cache'
    });
    res.end();
    return;
  }
  
  // 根据状态码决定如何处理
  if(status===404){
    // 检查是否是静态资源请求
    if(req.url.match(/\.(js|css|jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$/i)){
      // 尝试从备用源获取
      const fallbackUrl=req.url.replace(/^\/assets\//,'https://raw.githubusercontent.com/');
      axios.get(fallbackUrl,{
        responseType:'arraybuffer',
        timeout:10000,
        maxRedirects:5
      })
      .then(response=>{
        if(res.headersSent)return;
        res.statusCode=response.status;
        res.end(response.data);
      })
      .catch(fallbackError=>{
        console.error('备用源获取失败:',fallbackError.message);
        serveCustomErrorPage(config.customPages.notFoundPath,res,404);
      });
    }else{
      serveCustomErrorPage(config.customPages.notFoundPath,res,404);
    }
  }else if(status===403){
    serveCustomErrorPage(config.customPages.forbiddenPath,res,403);
  }else if(error.code==='ECONNABORTED'||safeError.message.includes('timeout')){
    sendErrorResponse(res,504,{error:'请求超时',message:'GitHub响应时间过长'});
  }else if(error.code==='ECONNREFUSED'){
    sendErrorResponse(res,502,{error:'连接失败',message:'无法连接到GitHub服务器'});
  }else if(safeError.message.includes('circular')||safeError.message.includes('cyclic')){
    // 特别处理循环引用错误
    sendErrorResponse(res,500,{error:'序列化错误',message:'处理响应时遇到循环引用问题'});
  }else{
    // 格式化错误消息
    const errorMsg=formatErrorMessage(safeError);
    sendErrorResponse(res,status,{error:'代理错误',message:errorMsg});
  }
};

// 格式化错误消息，提取有用信息
const formatErrorMessage=(error)=>{
  if(error.response){
    return `GitHub服务器响应错误: ${error.response.status} ${error.response.statusText||''}`;
  }else if(error.request){
    return `请求未收到响应: ${error.message}`;
  }else if(error.code){
    return `网络错误 (${error.code}): ${error.message}`;
  }else{
    return `代理错误: ${error.message}`;
  }
};

// 提供自定义错误页面
const serveCustomErrorPage=(pagePath,res,statusCode)=>{
  try{
    // 确保不重复发送响应
    if(res.headersSent)return false;
    
    let fullPath=path.join(process.cwd(),pagePath);
    console.log(`尝试加载错误页面: ${fullPath}`);
    
    if(!fs.existsSync(fullPath)){
      // 如果路径不存在，尝试其他可能的路径
      const altPath=pagePath.startsWith('.')?pagePath.substring(1):'/'+pagePath;
      fullPath=path.join(process.cwd(),altPath);
      console.log(`尝试备选路径: ${fullPath}`);
    }
    
    if(!fs.existsSync(fullPath)){
      // 如果还是找不到，直接使用绝对路径
      fullPath=path.resolve(pagePath.replace(/^\.?\/?public\//,'./public/'));
      console.log(`尝试绝对路径: ${fullPath}`);
    }
    
    if(!fs.existsSync(fullPath)){
      // 最后尝试直接访问public目录
      const filename=path.basename(pagePath);
      fullPath=path.join(process.cwd(),'public',filename);
      console.log(`尝试直接访问public目录: ${fullPath}`);
    }
    
    if(!fs.existsSync(fullPath)){
      throw new Error(`找不到错误页面: ${pagePath}`);
    }
    
    const content=fs.readFileSync(fullPath,'utf-8');
    res.writeHead(statusCode,{'Content-Type':'text/html; charset=utf-8'});
    res.end(content);
    console.log(`成功加载并发送错误页面: ${fullPath}`);
    return true;
  }catch(e){
    console.error(`无法加载自定义错误页面: ${pagePath}`,e.message);
    sendErrorResponse(res,statusCode,{error:'页面加载失败',message:e.message});
    return false;
  }
};

module.exports={
  safeStringify,
  sendErrorResponse,
  handleError,
  serveCustomErrorPage,
  getSafeError
}; 