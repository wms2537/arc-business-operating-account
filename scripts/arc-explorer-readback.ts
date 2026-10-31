import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {record,array,text,json} from '../src/lib/boundary';
const dir='docs/evidence/arc-testnet/rehearsal';
for(const label of ['co','cp','mixed']){
 const file=Bun.file(`${dir}/${label}-manifest.json`);if(!await file.exists())continue;
 const saved=Bun.file(`${dir}/${label}-explorer-status.json`);if(await saved.exists()){const prior=record(await saved.json());if(prior.verified===true){console.log('EXPLORER_RETAINED_VERIFIED',label);continue;}}
 const m=record(await file.json()),address=text(m.kernelAddress);
 const endpoint=new URL('https://explorer.testnet.arc.io/api');endpoint.search=new URLSearchParams({module:'contract',action:'getsourcecode',address}).toString();
 const response=await fetch(endpoint);const raw=await response.text();
 if(!response.ok){console.log('EXPLORER_HTTP',label,response.status,'RETRY_AFTER',response.headers.get('retry-after'));process.exitCode=1;continue;}
 let result:unknown;try{result=JSON.parse(raw)}catch{console.log('EXPLORER_NOT_JSON',label,raw.slice(0,80));continue;}
 await writeFile(`${dir}/${label}-explorer-source.json`,json(result));
 const top=record(result),first=array(top.result)[0],row=record(first),source=typeof row.SourceCode==='string'?row.SourceCode:'';
 const verified=top.status==='1'&&source.length>0&&typeof row.ABI==='string'&&row.ABI.startsWith('[');
 const report={label,address,verified,status:top.status,message:top.message,contractName:row.ContractName,compilerVersion:row.CompilerVersion,optimizationUsed:row.OptimizationUsed,runs:row.Runs,sourceLength:source.length,sourceSha256:createHash('sha256').update(source).digest('hex'),url:`https://explorer.testnet.arc.io/address/${address}`};
 await writeFile(`${dir}/${label}-explorer-status.json`,json(report)+'\n');console.log(json(report));
 await Bun.sleep(10000);
}
