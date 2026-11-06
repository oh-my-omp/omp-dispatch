export type Language='en'|'zh';
/** Resolution is environment-only and read live on every call: OMOMP_LANG, then locale, then English. */
export function language():Language {
  const explicit=process.env.OMOMP_LANG?.trim().toLowerCase();
  if(explicit==='en'||explicit==='zh')return explicit;
  for(const key of ['LC_ALL','LC_MESSAGES','LANG'] as const){const value=process.env[key]?.trim();if(value)return value.toLowerCase().startsWith('zh')?'zh':'en';}
  return 'en';
}
export function tr(en:string,zh:string):string {return language()==='zh'?zh:en;}
