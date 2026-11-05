import {noSecret} from './validation.js';
export function viewText(value,max=1200){
 if(typeof value!=='string')return '';
 try{noSecret(value);if(/sk-[a-zA-Z0-9_-]{20,}|(?:cookie|authorization)\s*[:=]|(?:access_token|refresh_token|api_key)\s*[:=]|[?&](?:token|access_token|refresh_token|auth|secret|signature)=/i.test(value))return '【含凭据模式，内容已隐藏】';}catch{return '【含凭据模式，内容已隐藏】';}
 return value.slice(0,max)+(value.length>max?'…【有截断】':'');
}
