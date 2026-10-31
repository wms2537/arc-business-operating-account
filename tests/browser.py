import json,time,traceback,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
OUT=Path('docs/evidence/browser');FIX=json.loads((OUT/'fixtures.json').read_text());checks=[];errors=[]
def check(name,actual,expected=True):
 ok=actual==expected;checks.append({'name':name,'actual':actual,'expected':expected,'status':'passed' if ok else 'failed'})
 if not ok:raise AssertionError(f'{name}: {actual} != {expected}')
def get(path):return json.load(urllib.request.urlopen('http://127.0.0.1:3201'+path))
def rpc(method,params):
 req=urllib.request.Request('http://127.0.0.1:18545',data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'content-type':'application/json'})
 result=json.load(urllib.request.urlopen(req))
 if 'error' in result:raise RuntimeError(result['error'])
 return result['result']
provider=r"""({accounts})=>{
 if(!['http:','https:'].includes(location.protocol))return;
 const listeners=new Map();let signer=sessionStorage.getItem('test-signer')||accounts[2],chain='0x7a69';
 const emit=(event,value)=>(listeners.get(event)||[]).forEach(fn=>fn(value));
 const rpc=async(method,params=[])=>{const r=await fetch('http://127.0.0.1:18545',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();if(j.error)throw j.error;return j.result;};
 const test={sends:0,lose:false,reject:false,hold:false,release:null,switchSigner(address){signer=address;sessionStorage.setItem('test-signer',address);emit('accountsChanged',[signer]);},switchChain(id){chain=id;emit('chainChanged',id);}};
 const ethereum={isMetaMask:true,on(event,fn){listeners.set(event,[...(listeners.get(event)||[]),fn]);return this;},removeListener(event,fn){listeners.set(event,(listeners.get(event)||[]).filter(f=>f!==fn));return this;},async request({method,params=[]}){
 if(method==='eth_accounts'||method==='eth_requestAccounts')return[signer];if(method==='eth_chainId')return chain;
 if(method==='wallet_requestPermissions')return[{parentCapability:'eth_accounts'}];if(method==='wallet_getPermissions')return[{parentCapability:'eth_accounts'}];
 if(method==='wallet_switchEthereumChain'){test.switchChain(params[0].chainId);return null;}
 if(method==='eth_sendTransaction'){
 if(test.reject){test.reject=false;throw{code:4001,message:'User rejected test request'};}
 if(test.hold)await new Promise(resolve=>{test.release=resolve;});
 test.sends++;const hash=await rpc(method,params);if(test.lose){test.lose=false;for(let i=0;i<100;i++){if(await rpc('eth_getTransactionReceipt',[hash]))break;await new Promise(r=>setTimeout(r,20));}throw{code:-32000,message:'Injected lost wallet response after broadcast'};}return hash;
 }
 return rpc(method,params);
 }};
 Object.defineProperty(window,'ethereum',{value:ethereum,configurable:true});window.__testWallet=test;
}"""
try:
 p=sync_playwright().start()
 browser=p.chromium.launch(headless=True,args=['--no-sandbox']);context=browser.new_context(viewport={'width':1440,'height':1000});context.add_init_script('('+provider+')('+json.dumps({'accounts':FIX['actors']})+')');page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:3201');page.wait_for_load_state('networkidle');expect(page.get_by_role('button',name='Refresh state',exact=True)).to_be_enabled();page.screenshot(path=str(OUT/'account-desktop.png'),full_page=True)
 (OUT/'initial-dom.html').write_text(page.content());(OUT/'initial-controls.json').write_text(json.dumps(page.get_by_role('button').all_text_contents()))
 check('local environment is explicit',page.get_by_text('Local test chain',exact=True).is_visible());check('six screens',page.locator('nav button').count(),6)
 page.get_by_role('button',name='Connect wallet',exact=True).click();expect(page.get_by_role('button',name='Disconnect',exact=True)).to_be_visible();expect(page.get_by_role('button',name='Refresh state',exact=True)).to_be_enabled()
 # Open a nonfinancial review, then change signer and network while reviewing.
 floor=page.locator('details').filter(has=page.get_by_text('Set protected cash',exact=True));floor.locator('summary').click();floor.get_by_role('button',name='Review set protected cash',exact=True).click();expect(page.get_by_role('dialog')).to_be_visible()
 page.evaluate('(a)=>window.__testWallet.switchSigner(a)',FIX['actors'][3]);expect(page.get_by_role('dialog')).to_have_count(0);check('signer change closes review',True);expect(page.get_by_role('button',name='Refresh state',exact=True)).to_be_enabled();check('viewing account does not grant authority',floor.get_by_role('button',name='Review set protected cash',exact=True).is_disabled())
 page.evaluate('(a)=>window.__testWallet.switchSigner(a)',FIX['actors'][2]);expect(page.get_by_role('button',name='Refresh state',exact=True)).to_be_enabled();page.evaluate("window.__testWallet.switchChain('0x4ce132')");expect(floor.get_by_text('Switch your wallet',exact=False)).to_be_visible();check('wrong network blocks action',floor.get_by_role('button',name='Review set protected cash',exact=True).is_disabled());page.evaluate("window.__testWallet.switchChain('0x7a69')")
 # Exact close review, reject once, then lose a response after actual financial close.
 page.get_by_role('button',name='Operation detail',exact=True).click();expect(page.get_by_text('Ready for financial close',exact=True)).to_be_visible();check('approval and reservation state displayed',page.get_by_role('heading',name='Current reservations and approvals').is_visible())
 close=page.locator('details').filter(has=page.get_by_text('Commit financial close',exact=True));close.locator('summary').click();close.get_by_role('button',name='Review commit financial close',exact=True).click();dialog=page.get_by_role('dialog');expect(dialog).to_be_visible();check('close review lists financial amounts',dialog.locator('dl[aria-label="Financial close amounts"]').count(),1);check('close review exact supplier payout','6.00 USDC' in dialog.inner_text());check('operation review excludes unrelated selected-account cash','Current protected / available cash' not in dialog.inner_text());check('merchant protection belongs to the plan participant',dialog.get_by_text('Merchant protected cash',exact=True).locator('xpath=following-sibling::dd[1]').inner_text(),'2.00 USDC');page.screenshot(path=str(OUT/'close-review.png'),full_page=True)
 page.keyboard.press('Tab');check('review keyboard focus stays in dialog',page.evaluate("!!document.activeElement.closest('[role=dialog]')"));page.keyboard.press('Escape');expect(page.get_by_role('dialog')).to_have_count(0);check('Escape closes review',True);close.get_by_role('button',name='Review commit financial close',exact=True).click()
 lock_page=context.new_page();lock_page.goto('http://127.0.0.1:3201');lock_page.wait_for_load_state('networkidle')
 lock_page.evaluate("""async (address)=>{let ready;const acquired=new Promise(r=>ready=r);void navigator.locks.request('arc-wallet:31337:'+address.toLowerCase(),()=>{ready();return new Promise(resolve=>window.releaseTestWalletLock=resolve);});await acquired;}""",FIX['actors'][2])
 page.get_by_role('dialog').get_by_role('button',name='Confirm in wallet').click();expect(page.get_by_text('Another tab has an active wallet request. Resolve it there first.',exact=True)).to_be_visible();check('another tab cannot race the wallet nonce',page.evaluate('window.__testWallet.sends'),0);lock_page.evaluate('window.releaseTestWalletLock()');lock_page.close()
 page.evaluate('window.__testWallet.reject=true');dialog.get_by_role('button',name='Confirm in wallet').click();expect(page.get_by_text('The wallet request was declined.',exact=True)).to_be_visible();check('rejected request sent no transaction',page.evaluate('window.__testWallet.sends'),0)
 expect(page.get_by_role('button',name='Refresh state',exact=True)).to_be_enabled();close.get_by_role('button',name='Review commit financial close',exact=True).click();page.evaluate('window.__testWallet.lose=true');page.get_by_role('dialog').get_by_role('button',name='Confirm in wallet').click();expect(page.get_by_text('Wallet response is uncertain. Use Recover status; do not submit again.',exact=True)).to_be_visible();check('lost response sent once',page.evaluate('window.__testWallet.sends'),1)
 saved=page.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('arc-business-intent-v3:')).map(k=>JSON.parse(localStorage.getItem(k))).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))");check('unknown financial intent persisted',saved[-1]['state']['kind'],'unknown');check('unknown intent has no invented hash','hash' in saved[-1]['state'],False)
 page.reload();page.wait_for_load_state('networkidle');expect(page.get_by_role('button',name='Refresh state',exact=True)).to_be_enabled();rows=page.locator('.transaction-row');rows.last.get_by_role('button',name='Recover status').click();expect(rows.last).to_contain_text('Confirmed');check('reload recovery did not submit again',page.evaluate('window.__testWallet.sends'),0)
 # Poll saved journal/API state and refresh before checking book-posted status.
 for _ in range(80):
  b=get('/api/books?deployment='+FIX['co']['instanceId'])
  if any(j['kind']=='PlanCommitted' for j in b['journals']):break
  time.sleep(.1)
 close_sources={j['source'] for j in b['journals'] if j['kind']=='PlanCommitted'};check('actual financial close posted once',len(close_sources),1);check('actual merchant cash after close',next(x['debitBalance'] for x in b['balances'] if x['entity']=='merchant' and x['account']=='cash'),'2000000')
 page.get_by_role('button',name='Refresh state',exact=True).click();expect(page.get_by_role('button',name='Refresh state',exact=True)).to_be_enabled();rows.last.get_by_role('button',name='Recover status').click();expect(rows.last).to_contain_text('books posted');check('confirmed status distinguishes posted books',True)
 # Every screen, desktop/mobile geometry, keyboard focus.
 for screen in ['Account','Operations','Operation detail','Funding','Books','Evidence']:
  page.get_by_role('button',name=screen,exact=True).click();check('desktop '+screen+' has no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));page.screenshot(path=str(OUT/('desktop-'+screen.lower().replace(' ','-')+'.png')),full_page=True)
 page.set_viewport_size({'width':390,'height':844})
 for screen in ['Account','Operations','Operation detail','Funding','Books','Evidence']:
  page.get_by_role('button',name=screen,exact=True).click();check('phone '+screen+' has no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));page.screenshot(path=str(OUT/('phone-'+screen.lower().replace(' ','-')+'.png')),full_page=True)
 page.keyboard.press('Tab');check('keyboard focus reaches a control',page.evaluate("['BUTTON','INPUT','SELECT','SUMMARY','A'].includes(document.activeElement.tagName)"))
 # Switch to an independent deployment and sign buyer B's previously unreceived allocation.
 held=[];old_pattern='**/api/books?deployment='+FIX['co']['instanceId'];page.route(old_pattern,lambda route:held.append(route));page.get_by_role('button',name='Refresh state',exact=True).click();page.wait_for_timeout(300);check('old deployment read held in flight',len(held),1)
 page.get_by_role('combobox',name='Deployment',exact=True).select_option(FIX['cp']['instanceId']);expect(page.get_by_role('button',name='Refresh state',exact=True)).to_be_enabled();held[0].fulfill(status=200,content_type='application/json',body=json.dumps(b));page.wait_for_load_state('networkidle');page.unroute(old_pattern);page.get_by_role('button',name='Operation detail',exact=True).click();expect(page.get_by_role('heading',name='Group purchase #1',exact=True)).to_be_visible();check('stale response cannot replace new deployment',True)
 page.evaluate('(a)=>window.__testWallet.switchSigner(a)',FIX['actors'][6]);expect(page.get_by_role('button',name='Refresh state',exact=True)).to_be_enabled();page.get_by_role('button',name='Operation detail',exact=True).click();expect(page.get_by_role('heading',name='Group purchase #1',exact=True)).to_be_visible();check('deployment switch loads group terms',True)
 before=get('/api/books?deployment='+FIX['cp']['instanceId']);page.get_by_role('button',name='Sign goods receipt for 35 units',exact=True).click();expect(page.get_by_text('Buyer-signed delivery receipt recorded. Cash and debt are unchanged.',exact=True)).to_be_visible();after=get('/api/books?deployment='+FIX['cp']['instanceId']);check('signed receipt retained',len(after['receipts']),len(before['receipts'])+1);check('signed receipt recognizes buyer inventory',next(x['debitBalance'] for x in after['balances'] if x['entity']=='buyerB' and x['account']=='inventory:1'),'315000');check('signed receipt sends no chain transaction',page.evaluate('window.__testWallet.sends'),0)
 check('signed receipt cash unchanged',[x for x in after['balances'] if x['account']=='cash'],[x for x in before['balances'] if x['account']=='cash']);page.get_by_role('button',name='Evidence',exact=True).click();page.screenshot(path=str(OUT/'signed-receipt-phone.png'),full_page=True)
 # Closed-while-awaiting state becomes recoverable uncertainty on next load.
 page.evaluate("""()=>{const items=Object.keys(localStorage).filter(k=>k.startsWith('arc-business-intent-v3:')).map(k=>JSON.parse(localStorage.getItem(k))).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));const last=items[items.length-1];last.state={kind:'awaiting-wallet'};localStorage.setItem('arc-business-intent-v3:'+last.id,JSON.stringify(last));}""");page.reload();page.wait_for_load_state('networkidle');check('interrupted wallet state recovers as unknown',page.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('arc-business-intent-v3:')).map(k=>JSON.parse(localStorage.getItem(k))).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id)).at(-1).state.kind"),'unknown')
 # Reject any mismatched deployment response rather than displaying another ledger.
 page.route('**/api/books?deployment=*',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps({**after,'deployment':FIX['co']['instanceId']})))
 page.get_by_role('combobox',name='Deployment',exact=True).select_option(FIX['cp']['instanceId']);page.get_by_role('button',name='Refresh state',exact=True).click();expect(page.get_by_text('Books response belongs to another deployment',exact=True)).to_be_visible();check('foreign ledger response rejected',True);page.unroute('**/api/books?deployment=*')
 for endpoint in ['/api/reset','/api/sign','/api/send']:
  response=page.request.post('http://127.0.0.1:3201'+endpoint+'?deployment='+FIX['cp']['instanceId'],data={});check('no public mutation endpoint '+endpoint,response.status,405)
 check('no unhandled browser exceptions',errors,[]);browser.close()
except Exception as e:
 try:
  if 'page' in globals():page.screenshot(path=str(OUT/'failure.png'),full_page=True);(OUT/'failure.html').write_text(page.content())
 except Exception:pass
 errors.append(traceback.format_exc());checks.append({'name':'browser runner','status':'failed','actual':str(e),'expected':'all browser flows complete'});print(traceback.format_exc());raise
finally:
 if 'browser' in globals():browser.close()
 if 'p' in globals():p.stop()
 (OUT/'checks.json').write_text(json.dumps({'environment':'local-anvil','wallet':'test-only injected EIP1193 provider with actual Anvil RPC transactions','checks':checks,'errors':errors},indent=2));print('BROWSER_CHECKS',len(checks),'FAILED',sum(c['status']!='passed' for c in checks))
