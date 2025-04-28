const axios=require('axios');
const {safeStringify}=require('./errorHandler');

// 创建自定义的axios实例
const createAxiosClient=(options={})=>{
  const defaultOptions={
    timeout:30000,
    maxContentLength:50*1024*1024,
    maxRedirects:5,
    headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36 GithubProxy/1.0'
    },
    retry:3,
    retryDelay:1000
  };
  
  const client=axios.create({...defaultOptions,...options});
  
  // 请求拦截器
  client.interceptors.request.use(
    config=>{
      // 添加请求开始时间，用于计算请求时长
      config.metadata={startTime:Date.now()};
      // 确保retry配置传递
      config.retry=config.retry||defaultOptions.retry;
      config.retryDelay=config.retryDelay||defaultOptions.retryDelay;
      config.retryCount=0;
      return config;
    },
    error=>{
      // 清理错误对象中可能的循环引用
      const safeError={
        message:error.message,
        name:error.name,
        code:error.code
      };
      return Promise.reject(safeError);
    }
  );
  
  // 响应拦截器
  client.interceptors.response.use(
    response=>{
      // 添加响应时间信息
      const duration=Date.now()-response.config.metadata.startTime;
      response.duration=duration;
      
      // 从响应中移除可能导致循环引用的属性
      if(response.request){
        // 保留一些必要的请求信息，但去掉可能导致循环引用的部分
        response.requestInfo={
          method:response.config.method,
          url:response.config.url,
          status:response.status,
          statusText:response.statusText,
          duration:duration
        };
        
        // 删除可能导致循环引用的属性
        delete response.request;
        delete response.config;
      }
      
      return response;
    },
    error=>{
      const config=error.config;
      
      // 实现重试逻辑处理连接重置等网络错误
      if(config&&(error.code==='ECONNRESET'||error.code==='ECONNABORTED'||error.code==='ETIMEDOUT')&&config.retryCount<config.retry){
        config.retryCount++;
        console.log(`请求失败(${error.code})，正在进行重试 ${config.retryCount}/${config.retry}: ${config.url}`);
        return new Promise(resolve=>{
          setTimeout(()=>{
            resolve(client(config));
          },config.retryDelay*config.retryCount);
        });
      }
      
      // 为错误添加更多上下文信息
      let enhancedError={
        message:error.message,
        name:error.name,
        code:error.code
      };
      
      // 提取响应信息(如果存在)
      if(error.response){
        enhancedError.response={
          status:error.response.status,
          statusText:error.response.statusText,
          headers:error.response.headers?{...error.response.headers}:undefined
        };
        
        // 尝试提取响应数据
        if(error.response.data){
          if(Buffer.isBuffer(error.response.data)){
            try{
              const text=error.response.data.toString('utf-8');
              if(text.length<1000){ // 只处理合理大小的响应
                enhancedError.response.data=text;
              }else{
                enhancedError.response.data='[响应数据过大]';
              }
            }catch(e){
              enhancedError.response.data='[无法读取响应数据]';
            }
          }else if(typeof error.response.data==='object'){
            try{
              enhancedError.response.data=safeStringify(error.response.data).substring(0,500);
            }catch(e){
              enhancedError.response.data='[无法序列化响应数据]';
            }
          }else{
            enhancedError.response.data=String(error.response.data).substring(0,500);
          }
        }
      }
      
      // 提取请求信息
      if(error.config){
        enhancedError.requestInfo={
          method:error.config.method,
          url:error.config.url,
          timeout:error.config.timeout
        };
        
        // 计算请求时长(如果可能)
        if(error.config.metadata&&error.config.metadata.startTime){
          enhancedError.requestInfo.duration=Date.now()-error.config.metadata.startTime;
        }
      }
      
      return Promise.reject(enhancedError);
    }
  );
  
  return client;
};

// 创建默认客户端
const defaultClient=createAxiosClient();

// 创建针对大文件的客户端
const largeFileClient=createAxiosClient({
  timeout:180000, // 3分钟
  maxContentLength:500*1024*1024, // 500MB
  retry:5,
  headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36 GithubProxy/1.0',
    'Accept-Encoding':'gzip, deflate, br'
  }
});

// 创建静态资源客户端
const staticClient=createAxiosClient({
  timeout:20000, // 20秒
  maxContentLength:10*1024*1024, // 10MB
  headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36 GithubProxy/1.0'
  }
});

module.exports={
  default:defaultClient,
  largeFile:largeFileClient,
  static:staticClient,
  create:createAxiosClient
}; 