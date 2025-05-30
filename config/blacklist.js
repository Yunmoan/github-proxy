// 禁止访问的仓库名单配置
module.exports={
  "repositories": [
    "getlantern/lantern",
    "shadowsocks/shadowsocks-windows",
    "shadowsocks/shadowsocks-android",
    "v2ray/v2ray-core",
    "trojan-gfw/trojan",
    "yichengchen/clashx",
    "Dreamacro/clash",
    "klzgrad/naiveproxy",
    "Fndroid/clash_for_windows_pkg",
    "2dust/v2rayng",
    "XTLS/Xray-core",
    "xtaci/kcptun",
    "eycorsican/leaf",
    "haishanh/yacd",
    "xjasonlyu/tun2socks",
    "juewuy/ShellClash",
    "MetaCubeX/metacubexd"
  ],
  "keywords": [
    "clash",
    "v2ray",
    "shadowsocks",
    "ss-",
    "ssr-",
    "trojan",
    "lantern",
    "vpn",
    "proxies",
    "gfw",
    "greatfire",
    "unblock",
    "翻墙",
    "科学上网"
  ],
  "whitelistRepositories": [
    "example/vpn-detection",
    "educational/network-tools"
  ],
  "enabled": true,
  "logBlocked": true,
  "errorResponse": {
    "statusCode": 451,
    "message": "根据相关法律法规，该内容不予显示"
  }
};