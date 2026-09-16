(function(){
  // ===================== 設定 =====================
  const API_BASE_URL = 'https://candyblast-server.onrender.com';

  // ===================== 永続化ストレージ(localStorageベース) =====================
  // このアプリはRender上の通常のWebページとして動作するため、
  // (Claudeアーティファクト専用の window.storage ではなく)標準の localStorage を使う。
  // 呼び出し側のコードは変えずに済むよう、同じインターフェースのラッパーを用意する。
  const appStorage = {
    async get(key){
      try{
        const value = localStorage.getItem(key);
        if(value === null) return null;
        return { key, value, shared:false };
      }catch(err){ return null; }
    },
    async set(key, value){
      try{
        localStorage.setItem(key, value);
        return { key, value, shared:false };
      }catch(err){ return null; }
    },
    async delete(key){
      try{
        localStorage.removeItem(key);
        return { key, deleted:true, shared:false };
      }catch(err){ return null; }
    }
  };

  // ===================== Cookie操作(ログイン状態の保存に使用) =====================
  function setCookie(name, value, days){
    const expires = new Date(Date.now() + days*24*60*60*1000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  }
  function getCookie(name){
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }
  function deleteCookie(name){
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax`;
  }

  // ===================== ズーム無効化 =====================
  document.addEventListener('gesturestart', function(e) { e.preventDefault(); });
  document.addEventListener('gesturechange', function(e) { e.preventDefault(); });
  document.addEventListener('gestureend', function(e) { e.preventDefault(); });

  // ===================== ダブルタップズーム・ピンチズーム完全防止(iOS Safari対策) =====================
  let _lastTouchEndTime = 0;
  document.addEventListener('touchend', function(e){
    const now = Date.now();
    if(now - _lastTouchEndTime <= 350){
      e.preventDefault();
    }
    _lastTouchEndTime = now;
  }, { passive: false });

  document.addEventListener('touchstart', function(e){
    if(e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchmove', function(e){
    if(e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  document.addEventListener('dblclick', function(e){
    e.preventDefault();
  }, { passive: false });

  // ===================== 戻るボタン =====================
  document.getElementById('backButton').addEventListener('click', function(e) {
    e.preventDefault();
    if (confirm('メニューに戻りますか？\n現在のゲームの進行は保存されません。')) {
      showTitleScreen();
    }
  });

  // ===================== ゲーム本体 =====================
  let SIZE = 8;
  const COLORS = [
    {bg:'linear-gradient(135deg,#FF8B8B,#FF6B6B)'},
    {bg:'linear-gradient(135deg,#5FE3B3,#3DDC97)'},
    {bg:'linear-gradient(135deg,#6FB0FF,#4D96FF)'},
    {bg:'linear-gradient(135deg,#C9A8FF,#B18CFF)'},
    {bg:'linear-gradient(135deg,#FF95C9,#FF6FB5)'},
    {bg:'linear-gradient(135deg,#E1F065,#C6E62D)'},
    {bg:'linear-gradient(135deg,#FFE270,#FFD93D)'}
  ];

  const MODES = {
    soft:    { label:'柔らかい', emoji:'🍮' },
    baked:   { label:'焼成',     emoji:'🍪' },
    hard:    { label:'硬い',     emoji:'🍬' },
    extreme: { label:'激硬',     emoji:'🧊' }
  };
  let currentMode = 'baked';

  const MODE_COIN_MULT = { soft:0.5, baked:1.0, hard:1.5, extreme:3.0 };
  function sizeCoinMult(size){ return 8 / size; }
  function coinMultiplier(mode, size){
    const m = mode || currentMode, s = (m==='extreme') ? 8 : (size || SIZE);
    return MODE_COIN_MULT[m] * sizeCoinMult(s);
  }

  // ===================== スキン =====================
  // ===================== 背景画像(お好みの写真を背景に設定) =====================
  const STORAGE_BG_IMAGE = 'candyblast-bg-image-v1';
  let customBgDataUrl = null;

  function renderBgTab(){
    return `
      <div class="sub" style="margin-bottom:10px;">好きな写真を背景に設定できます。ブロックやパネルは前面にはっきり表示されるので、プレイに支障はありません。</div>
      <div style="width:100%; aspect-ratio:16/9; border-radius:14px; overflow:hidden; background:var(--panel);
        display:flex; align-items:center; justify-content:center; margin-bottom:12px; border:1px solid rgba(255,255,255,0.08);">
        ${customBgDataUrl
          ? `<img src="${customBgDataUrl}" style="width:100%; height:100%; object-fit:cover;">`
          : `<span class="sub">現在: デフォルト背景</span>`}
      </div>
      <input type="file" id="bgFileInput" accept="image/*" style="display:none;">
      <button class="primary-btn" id="bgPickBtn">🖼️ 画像を選択する</button>
      ${customBgDataUrl ? `<button class="ghost-btn" id="bgResetBtn">デフォルトに戻す</button>` : ''}
      <div class="sub" id="bgStatus" style="margin-top:8px;"></div>
    `;
  }

  function applyCustomBackground(dataUrl){
    if(dataUrl){
      document.body.style.backgroundImage =
        `linear-gradient(rgba(8,4,12,0.55), rgba(8,4,12,0.55)), url(${dataUrl})`;
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundPosition = 'center';
      document.body.style.backgroundAttachment = 'fixed';
    } else {
      document.body.style.backgroundImage = '';
      document.body.style.backgroundSize = '';
      document.body.style.backgroundPosition = '';
      document.body.style.backgroundAttachment = '';
    }
  }

  function setCustomBackgroundFromFile(file){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read failed'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('image failed'));
        img.onload = () => {
          const maxW = 1000;
          const scale = Math.min(1, maxW / img.width);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
          customBgDataUrl = dataUrl;
          applyCustomBackground(dataUrl);
          appStorage.set(STORAGE_BG_IMAGE, dataUrl, false).then(()=>resolve()).catch(reject);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function resetCustomBackground(){
    customBgDataUrl = null;
    applyCustomBackground(null);
    try{ await appStorage.delete(STORAGE_BG_IMAGE, false); }catch(err){}
  }

  async function loadCustomBackground(){
    try{
      const res = await appStorage.get(STORAGE_BG_IMAGE, false);
      if(res && res.value){
        customBgDataUrl = res.value;
        applyCustomBackground(customBgDataUrl);
      }
    }catch(err){}
  }

  const PATTERN_LAYERS = {
    stripe: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.32) 0 3px, transparent 3px 9px)',
    dot: 'radial-gradient(circle at 3px 3px, rgba(255,255,255,0.55) 1.6px, transparent 1.8px) 0 0/9px 9px',
    grid: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.26) 0 1.4px, transparent 1.4px 8px), repeating-linear-gradient(90deg, rgba(255,255,255,0.26) 0 1.4px, transparent 1.4px 8px)',
    wave: 'repeating-linear-gradient(-45deg, rgba(255,255,255,0.28) 0 2px, transparent 2px 10px)',
    zigzag: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.3) 0 3px, transparent 3px 6px), repeating-linear-gradient(-45deg, rgba(255,255,255,0.3) 0 3px, transparent 3px 6px)',
    diamond: 'repeating-linear-gradient(60deg, rgba(255,255,255,0.24) 0 2px, transparent 2px 9px), repeating-linear-gradient(-60deg, rgba(255,255,255,0.24) 0 2px, transparent 2px 9px)'
  };
  const PATTERN_LABELS = { stripe:'ストライプ', dot:'ドット', grid:'グリッド', wave:'ウェーブ', zigzag:'ジグザグ', diamond:'ダイヤ柄' };

  const SKINS = [
    { id:'default', name:'ミッドナイトキャンディ', price:0, desc:'定番のパープル×ゴールドの夜空テーマ。',
      vars:{ '--bg-deep':'#1a1233','--bg-deep2':'#241a45','--panel':'#2c2054','--panel-light':'#382a68',
        '--gold':'#FFD93D','--coral':'#FF6B6B','--mint':'#3DDC97','--blue':'#4D96FF','--purple':'#B18CFF',
        '--pink':'#FF6FB5','--lime':'#C6E62D','--text':'#F5F3FF','--text-dim':'#B7ADDA' },
      titleGrad:'linear-gradient(90deg, #FFD93D, #FF6FB5)',
      colors:[
        {bg:'linear-gradient(135deg,#FF8B8B,#FF6B6B)'},{bg:'linear-gradient(135deg,#5FE3B3,#3DDC97)'},
        {bg:'linear-gradient(135deg,#6FB0FF,#4D96FF)'},{bg:'linear-gradient(135deg,#C9A8FF,#B18CFF)'},
        {bg:'linear-gradient(135deg,#FF95C9,#FF6FB5)'},{bg:'linear-gradient(135deg,#E1F065,#C6E62D)'},
        {bg:'linear-gradient(135deg,#FFE270,#FFD93D)'}
      ] },
    { id:'sunset', name:'サンセットソーダ', price:800, desc:'夕焼けとクリームソーダの暖色パレット。',
      vars:{ '--bg-deep':'#2b1024','--bg-deep2':'#4a1730','--panel':'#5c2038','--panel-light':'#742a44',
        '--gold':'#FFB74D','--coral':'#FF6B4A','--mint':'#FFD97D','--blue':'#FF8F6B','--purple':'#FF9AA8',
        '--pink':'#FF5E8E','--lime':'#FFDD6B','--text':'#FFF3E8','--text-dim':'#E3AFAF' },
      titleGrad:'linear-gradient(90deg,#FFB74D,#FF5E8E)',
      colors:[
        {bg:'linear-gradient(135deg,#FFB199,#FF7B54)'},{bg:'linear-gradient(135deg,#FFD97D,#FFB74D)'},
        {bg:'linear-gradient(135deg,#FF9AA8,#FF5E8E)'},{bg:'linear-gradient(135deg,#FFCF6B,#FF9A3C)'},
        {bg:'linear-gradient(135deg,#FF8AAE,#E8497A)'},{bg:'linear-gradient(135deg,#FFE29A,#FFC15E)'},
        {bg:'linear-gradient(135deg,#FF7E67,#E8503A)'}
      ] },
    { id:'ocean', name:'ディープオーシャン', price:1000, desc:'深海の静けさをまとったブルー×ティール。',
      vars:{ '--bg-deep':'#07161f','--bg-deep2':'#0c2733','--panel':'#123444','--panel-light':'#1a4557',
        '--gold':'#4DE0E0','--coral':'#FF8A65','--mint':'#3DDCC0','--blue':'#4DA6FF','--purple':'#6FA8DC',
        '--pink':'#5FC9E8','--lime':'#7FE0C6','--text':'#EAFBFF','--text-dim':'#8FC4D6' },
      titleGrad:'linear-gradient(90deg,#4DE0E0,#4DA6FF)',
      colors:[
        {bg:'linear-gradient(135deg,#6FE3D8,#3DDCC0)'},{bg:'linear-gradient(135deg,#6FB0FF,#3E7EDB)'},
        {bg:'linear-gradient(135deg,#7FE0C6,#39B893)'},{bg:'linear-gradient(135deg,#8FD3FF,#4DA6FF)'},
        {bg:'linear-gradient(135deg,#5FC9E8,#2E9BC2)'},{bg:'linear-gradient(135deg,#4DE0E0,#20B2B2)'},
        {bg:'linear-gradient(135deg,#A0F0E6,#5FD6C4)'}
      ] },
    { id:'neon', name:'ネオンナイト', price:1400, desc:'漆黒に浮かぶ蛍光カラーのサイバーテーマ。',
      vars:{ '--bg-deep':'#08060f','--bg-deep2':'#120a24','--panel':'#1c1030','--panel-light':'#28163f',
        '--gold':'#F5FF3D','--coral':'#FF3DBB','--mint':'#3DFFD5','--blue':'#3DAFFF','--purple':'#B93DFF',
        '--pink':'#FF3DBB','--lime':'#C6FF3D','--text':'#F2F0FF','--text-dim':'#9C8FCC' },
      titleGrad:'linear-gradient(90deg,#F5FF3D,#FF3DBB)',
      colors:[
        {bg:'linear-gradient(135deg,#FF6DD9,#FF3DBB)'},{bg:'linear-gradient(135deg,#5DFFE0,#3DFFD5)'},
        {bg:'linear-gradient(135deg,#6DC3FF,#3DAFFF)'},{bg:'linear-gradient(135deg,#CE7DFF,#B93DFF)'},
        {bg:'linear-gradient(135deg,#FF7DCF,#FF3DBB)'},{bg:'linear-gradient(135deg,#E0FF6D,#C6FF3D)'},
        {bg:'linear-gradient(135deg,#FBFF6D,#F5FF3D)'}
      ] },
    { id:'sakura', name:'さくらパステル', price:1200, desc:'春の花びらのようなやわらかいピンク×白。',
      vars:{ '--bg-deep':'#2a1a22','--bg-deep2':'#3d2530','--panel':'#4a2c3a','--panel-light':'#5c3849',
        '--gold':'#FFC1CC','--coral':'#FF9EB5','--mint':'#C8F0DD','--blue':'#B8D8F0','--purple':'#D9C1EA',
        '--pink':'#FFB3D1','--lime':'#E8F0B8','--text':'#FFF6F8','--text-dim':'#D9AFC0' },
      titleGrad:'linear-gradient(90deg,#FFC1CC,#D9C1EA)',
      colors:[
        {bg:'linear-gradient(135deg,#FFD1DC,#FF9EB5)'},{bg:'linear-gradient(135deg,#D6F5E3,#C8F0DD)'},
        {bg:'linear-gradient(135deg,#D2E7FA,#B8D8F0)'},{bg:'linear-gradient(135deg,#E9D8F5,#D9C1EA)'},
        {bg:'linear-gradient(135deg,#FFC7E0,#FFB3D1)'},{bg:'linear-gradient(135deg,#F1F5C6,#E8F0B8)'},
        {bg:'linear-gradient(135deg,#FFE3EA,#FFC1CC)'}
      ] },
    { id:'goldlux', name:'ゴールドラグジュアリー', price:2500, desc:'漆黒とゴールドの高級ジュエリーテーマ。',
      vars:{ '--bg-deep':'#0a0a0a','--bg-deep2':'#161412','--panel':'#211c16','--panel-light':'#332b1f',
        '--gold':'#F5D57A','--coral':'#E8A33D','--mint':'#D4B26A','--blue':'#C9A24A','--purple':'#B8934A',
        '--pink':'#F0C97A','--lime':'#E0C05A','--text':'#FBF3E0','--text-dim':'#B8A582' },
      titleGrad:'linear-gradient(90deg,#F5D57A,#E8A33D)',
      colors:[
        {bg:'linear-gradient(135deg,#F5D57A,#D4A94A)'},{bg:'linear-gradient(135deg,#F0C060,#D89B2E)'},
        {bg:'linear-gradient(135deg,#E8B84A,#C79430)'},{bg:'linear-gradient(135deg,#F5E0A0,#E0BA5A)'},
        {bg:'linear-gradient(135deg,#D9A94E,#B8873A)'},{bg:'linear-gradient(135deg,#F0D890,#DDB758)'},
        {bg:'linear-gradient(135deg,#EFCB74,#C99A3E)'}
      ] },
    { id:'emerald', name:'エメラルドヴェール', price:1600, desc:'深緑のジャングルに宿る宝石の輝き。',
      vars:{ '--bg-deep':'#04140f','--bg-deep2':'#082018','--panel':'#0e3226','--panel-light':'#154436',
        '--gold':'#3DFFA8','--coral':'#5CFF7A','--mint':'#3DDCA0','--blue':'#4DFFC8','--purple':'#7DFFB0',
        '--pink':'#8CFFD1','--lime':'#B6FF6B','--text':'#E9FFF5','--text-dim':'#8FC7AE' },
      titleGrad:'linear-gradient(90deg,#3DFFA8,#B6FF6B)',
      colors:[
        {bg:'linear-gradient(135deg,#5CFFB0,#20D18A)'},{bg:'linear-gradient(135deg,#8CFFD1,#3DDCA0)'},
        {bg:'linear-gradient(135deg,#4DFFC8,#20B58F)'},{bg:'linear-gradient(135deg,#B6FF6B,#7CD936)'},
        {bg:'linear-gradient(135deg,#7DFFB0,#2FBE7C)'},{bg:'linear-gradient(135deg,#D0FFA0,#9EE85A)'},
        {bg:'linear-gradient(135deg,#3DFFA8,#0FAE72)'}
      ] },
    { id:'galaxy', name:'ギャラクシードリーム', price:1800, desc:'渦巻く銀河と星屑をまとった幻想パレット。',
      vars:{ '--bg-deep':'#05041a','--bg-deep2':'#0c0930','--panel':'#150f45','--panel-light':'#1e1660',
        '--gold':'#C8A2FF','--coral':'#FF6EC7','--mint':'#7FE7FF','--blue':'#6E8CFF','--purple':'#B36EFF',
        '--pink':'#FF6EC7','--lime':'#9E7FFF','--text':'#F1ECFF','--text-dim':'#9C8FD6' },
      titleGrad:'linear-gradient(90deg,#C8A2FF,#FF6EC7)',
      colors:[
        {bg:'linear-gradient(135deg,#FF9EE0,#FF6EC7)'},{bg:'linear-gradient(135deg,#9EE7FF,#7FE7FF)'},
        {bg:'linear-gradient(135deg,#9EB0FF,#6E8CFF)'},{bg:'linear-gradient(135deg,#DDB0FF,#B36EFF)'},
        {bg:'linear-gradient(135deg,#FF9EE0,#E86EDB)'},{bg:'linear-gradient(135deg,#C6B0FF,#9E7FFF)'},
        {bg:'linear-gradient(135deg,#E8CFFF,#C8A2FF)'}
      ] },
    { id:'volcano', name:'ヴォルケーノブレイズ', price:1300, desc:'噴火するマグマの熱と灰の黒を纏う。',
      vars:{ '--bg-deep':'#140503','--bg-deep2':'#240906','--panel':'#3a0f08','--panel-light':'#54160c',
        '--gold':'#FFB627','--coral':'#FF4500','--mint':'#FF7A3D','--blue':'#FF9040','--purple':'#FF5E2E',
        '--pink':'#FF7A3D','--lime':'#FFD23D','--text':'#FFF1E0','--text-dim':'#D69880' },
      titleGrad:'linear-gradient(90deg,#FFB627,#FF4500)',
      colors:[
        {bg:'linear-gradient(135deg,#FF7A3D,#FF4500)'},{bg:'linear-gradient(135deg,#FFD23D,#FFB627)'},
        {bg:'linear-gradient(135deg,#FF9040,#E8380A)'},{bg:'linear-gradient(135deg,#FF5E2E,#C22E0C)'},
        {bg:'linear-gradient(135deg,#FFC15E,#FF8A1E)'},{bg:'linear-gradient(135deg,#FF3D3D,#B31C1C)'},
        {bg:'linear-gradient(135deg,#FFA23D,#E86A0A)'}
      ] },
    { id:'frost', name:'アークティックフロスト', price:1500, desc:'極寒のオーロラと氷結晶の透明感。',
      vars:{ '--bg-deep':'#031420','--bg-deep2':'#062331','--panel':'#0b3548','--panel-light':'#124861',
        '--gold':'#B7F5FF','--coral':'#7DE8FF','--mint':'#9CFFF0','--blue':'#5AC8FF','--purple':'#A0E0FF',
        '--pink':'#C9F5FF','--lime':'#B6FFEA','--text':'#EEFCFF','--text-dim':'#88C0D6' },
      titleGrad:'linear-gradient(90deg,#B7F5FF,#5AC8FF)',
      colors:[
        {bg:'linear-gradient(135deg,#D6FBFF,#9CFFF0)'},{bg:'linear-gradient(135deg,#9CE0FF,#5AC8FF)'},
        {bg:'linear-gradient(135deg,#B6FFEA,#6FE8C8)'},{bg:'linear-gradient(135deg,#C9E8FF,#7DA8FF)'},
        {bg:'linear-gradient(135deg,#A0E0FF,#4FA9E8)'},{bg:'linear-gradient(135deg,#E0FBFF,#B7F5FF)'},
        {bg:'linear-gradient(135deg,#7DE8FF,#33B8DB)'}
      ] },
    { id:'royal', name:'ロイヤルアメジスト', price:2200, desc:'王家の紫水晶と銀細工の格式高いテーマ。',
      vars:{ '--bg-deep':'#100519','--bg-deep2':'#1c0a2c','--panel':'#2b1042','--panel-light':'#3c1858',
        '--gold':'#D8B4FE','--coral':'#E879F9','--mint':'#C4B5FD','--blue':'#A78BFA','--purple':'#9333EA',
        '--pink':'#E879F9','--lime':'#C4B5FD','--text':'#F5EEFF','--text-dim':'#B79CDB' },
      titleGrad:'linear-gradient(90deg,#D8B4FE,#E879F9)',
      colors:[
        {bg:'linear-gradient(135deg,#E4C8FF,#C084FC)'},{bg:'linear-gradient(135deg,#F0ABFC,#E879F9)'},
        {bg:'linear-gradient(135deg,#C4B5FD,#A78BFA)'},{bg:'linear-gradient(135deg,#D9C4FF,#9333EA)'},
        {bg:'linear-gradient(135deg,#EAD0FF,#B366F0)'},{bg:'linear-gradient(135deg,#F5D9FF,#D8B4FE)'},
        {bg:'linear-gradient(135deg,#BFA0F5,#8B4FE0)'}
      ] },
    { id:'candyland', name:'キャンディランド祭典', price:1000, desc:'遊園地の光と綿菓子のようなにぎやかなポップ配色。',
      vars:{ '--bg-deep':'#1a0e2e','--bg-deep2':'#2a1642','--panel':'#391d57','--panel-light':'#4a2670',
        '--gold':'#FFE156','--coral':'#FF5E7C','--mint':'#5CFFCB','--blue':'#5CB8FF','--purple':'#C25CFF',
        '--pink':'#FF5CC8','--lime':'#CBFF5C','--text':'#FFFAF0','--text-dim':'#C9A8E0' },
      titleGrad:'linear-gradient(90deg,#FFE156,#FF5CC8)',
      colors:[
        {bg:'linear-gradient(135deg,#FF8FA3,#FF5E7C)'},{bg:'linear-gradient(135deg,#7CFFDD,#5CFFCB)'},
        {bg:'linear-gradient(135deg,#8FCDFF,#5CB8FF)'},{bg:'linear-gradient(135deg,#DA8FFF,#C25CFF)'},
        {bg:'linear-gradient(135deg,#FF8FE0,#FF5CC8)'},{bg:'linear-gradient(135deg,#E3FF8F,#CBFF5C)'},
        {bg:'linear-gradient(135deg,#FFEC8F,#FFE156)'}
      ] },
    { id:'obsidian', name:'オブシディアンヴェノム', price:2000, desc:'黒曜石の闇に猛毒の緑が走る、上級者向けダークテーマ。',
      vars:{ '--bg-deep':'#020202','--bg-deep2':'#0a0a0a','--panel':'#131313','--panel-light':'#1e1e1e',
        '--gold':'#39FF14','--coral':'#FF073A','--mint':'#39FF14','--blue':'#00FFFF','--purple':'#8B00FF',
        '--pink':'#FF073A','--lime':'#CCFF00','--text':'#F0FFF0','--text-dim':'#6E8C6E' },
      titleGrad:'linear-gradient(90deg,#39FF14,#00FFFF)',
      colors:[
        {bg:'linear-gradient(135deg,#39FF14,#1EA80D)'},{bg:'linear-gradient(135deg,#CCFF00,#8FB800)'},
        {bg:'linear-gradient(135deg,#00FFFF,#00A8A8)'},{bg:'linear-gradient(135deg,#8B00FF,#5A00A8)'},
        {bg:'linear-gradient(135deg,#FF073A,#A80426)'},{bg:'linear-gradient(135deg,#39FF88,#0DB859)'},
        {bg:'linear-gradient(135deg,#CFFF39,#94D40D)'}
      ] },
    { id:'sakuraroyale', name:'桜皇家ゴールド', price:3000, desc:'金箔と桜吹雪をあしらった、極めて豪華な限定テーマ。',
      vars:{ '--bg-deep':'#170a10','--bg-deep2':'#26111a','--panel':'#391a27','--panel-light':'#4d2434',
        '--gold':'#FFD700','--coral':'#FF7FA6','--mint':'#FFE9B0','--blue':'#FFC94D','--purple':'#E0A9C4',
        '--pink':'#FF9EC4','--lime':'#FFE066','--text':'#FFF6E9','--text-dim':'#D9AFC0' },
      titleGrad:'linear-gradient(90deg,#FFD700,#FF9EC4)',
      colors:[
        {bg:'linear-gradient(135deg,#FFE066,#FFD700)'},{bg:'linear-gradient(135deg,#FFC0DA,#FF9EC4)'},
        {bg:'linear-gradient(135deg,#FFE9B0,#FFC94D)'},{bg:'linear-gradient(135deg,#FFB8D6,#FF7FA6)'},
        {bg:'linear-gradient(135deg,#F5D6E4,#E0A9C4)'},{bg:'linear-gradient(135deg,#FFF0C6,#FFDD8A)'},
        {bg:'linear-gradient(135deg,#FFD9E8,#FFB0CE)'}
      ] },
    { id:'mintchoco', name:'ミントチョコレート', price:900, desc:'ミントの爽やかさとビターチョコの甘さの組み合わせ。',
      vars:{ '--bg-deep':'#1a120a','--bg-deep2':'#241a10','--panel':'#332415','--panel-light':'#453120',
        '--gold':'#C68642','--coral':'#A6673A','--mint':'#5FDDA8','--blue':'#7FC9A0','--purple':'#8B5A2B',
        '--pink':'#D9A679','--lime':'#8FE0B0','--text':'#FFF6EC','--text-dim':'#C9A88A' },
      titleGrad:'linear-gradient(90deg,#5FDDA8,#C68642)',
      colors:[
        {bg:'linear-gradient(135deg,#7FE8BC,#5FDDA8)'},{bg:'linear-gradient(135deg,#D9A679,#C68642)'},
        {bg:'linear-gradient(135deg,#8FE0B0,#4FC090)'},{bg:'linear-gradient(135deg,#B8845A,#8B5A2B)'},
        {bg:'linear-gradient(135deg,#9FE8C6,#6FCCA0)'},{bg:'linear-gradient(135deg,#E0B98A,#A6673A)'},
        {bg:'linear-gradient(135deg,#6FDDB0,#3FAE82)'}
      ] },
    { id:'lavender', name:'ラベンダーミルク', price:1100, desc:'ラベンダー畑とミルクのようなやさしい紫パステル。',
      vars:{ '--bg-deep':'#1c1526','--bg-deep2':'#2a1f3b','--panel':'#372a4d','--panel-light':'#473763',
        '--gold':'#D4B8FF','--coral':'#FFB8E0','--mint':'#C6D4FF','--blue':'#B0A8FF','--purple':'#9D7FE8',
        '--pink':'#E8B8FF','--lime':'#D0C6FF','--text':'#F5F0FF','--text-dim':'#B8A8D6' },
      titleGrad:'linear-gradient(90deg,#D4B8FF,#FFB8E0)',
      colors:[
        {bg:'linear-gradient(135deg,#E4D0FF,#D4B8FF)'},{bg:'linear-gradient(135deg,#FFD0EC,#FFB8E0)'},
        {bg:'linear-gradient(135deg,#D8E0FF,#C6D4FF)'},{bg:'linear-gradient(135deg,#C6BEFF,#B0A8FF)'},
        {bg:'linear-gradient(135deg,#B79DF0,#9D7FE8)'},{bg:'linear-gradient(135deg,#F0CCFF,#E8B8FF)'},
        {bg:'linear-gradient(135deg,#E0D8FF,#D0C6FF)'}
      ] },
    { id:'cherry', name:'チェリーソーダ', price:1300, desc:'ルビーのように濃いチェリーレッドの大人な一皿。',
      vars:{ '--bg-deep':'#1a0508','--bg-deep2':'#2c0810','--panel':'#3f0d18','--panel-light':'#571322',
        '--gold':'#FF4D6D','--coral':'#E8102E','--mint':'#FF7A94','--blue':'#FF3355','--purple':'#C4102C',
        '--pink':'#FF6B85','--lime':'#FF9EAE','--text':'#FFF0F2','--text-dim':'#D68A96' },
      titleGrad:'linear-gradient(90deg,#FF4D6D,#E8102E)',
      colors:[
        {bg:'linear-gradient(135deg,#FF7A94,#FF4D6D)'},{bg:'linear-gradient(135deg,#FF5070,#E8102E)'},
        {bg:'linear-gradient(135deg,#FF9EAE,#FF6B85)'},{bg:'linear-gradient(135deg,#FF4560,#C4102C)'},
        {bg:'linear-gradient(135deg,#FF849A,#F02E48)'},{bg:'linear-gradient(135deg,#FFB0BE,#FF7A94)'},
        {bg:'linear-gradient(135deg,#F03350,#A80D22)'}
      ] },
    { id:'citrus', name:'シトラスポップ', price:950, desc:'オレンジとレモンがはじけるビタミンカラー全開。',
      vars:{ '--bg-deep':'#1f1503','--bg-deep2':'#2e2005','--panel':'#412d08','--panel-light':'#553c0c',
        '--gold':'#FFC800','--coral':'#FF8C00','--mint':'#FFE066','--blue':'#FFA800','--purple':'#FFB627',
        '--pink':'#FFD23D','--lime':'#D4FF00','--text':'#FFFAE8','--text-dim':'#D6C088' },
      titleGrad:'linear-gradient(90deg,#FFC800,#FF8C00)',
      colors:[
        {bg:'linear-gradient(135deg,#FFDA4D,#FFC800)'},{bg:'linear-gradient(135deg,#FFAA4D,#FF8C00)'},
        {bg:'linear-gradient(135deg,#FFEB8A,#FFE066)'},{bg:'linear-gradient(135deg,#FFC15E,#FFA800)'},
        {bg:'linear-gradient(135deg,#FFCB5E,#FFB627)'},{bg:'linear-gradient(135deg,#FFE070,#FFD23D)'},
        {bg:'linear-gradient(135deg,#E8FF5E,#D4FF00)'}
      ] },
    { id:'monochrome', name:'モノクロームスタイル', price:1700, desc:'白と黒だけで魅せる、洗練されたミニマルテーマ。',
      vars:{ '--bg-deep':'#0a0a0a','--bg-deep2':'#161616','--panel':'#232323','--panel-light':'#333333',
        '--gold':'#E8E8E8','--coral':'#B0B0B0','--mint':'#D0D0D0','--blue':'#909090','--purple':'#C0C0C0',
        '--pink':'#A8A8A8','--lime':'#F0F0F0','--text':'#FFFFFF','--text-dim':'#999999' },
      titleGrad:'linear-gradient(90deg,#F0F0F0,#909090)',
      colors:[
        {bg:'linear-gradient(135deg,#F5F5F5,#D8D8D8)'},{bg:'linear-gradient(135deg,#C0C0C0,#9A9A9A)'},
        {bg:'linear-gradient(135deg,#D8D8D8,#B0B0B0)'},{bg:'linear-gradient(135deg,#A8A8A8,#787878)'},
        {bg:'linear-gradient(135deg,#CACACA,#A0A0A0)'},{bg:'linear-gradient(135deg,#E8E8E8,#C8C8C8)'},
        {bg:'linear-gradient(135deg,#909090,#606060)'}
      ] },
    { id:'aurora', name:'オーロラヴェール', price:2000, desc:'極北の夜空に揺らめくオーロラの神秘的な光。',
      vars:{ '--bg-deep':'#020f14','--bg-deep2':'#051e26','--panel':'#0a2e38','--panel-light':'#0f404d',
        '--gold':'#7FFFD4','--coral':'#FF7FE0','--mint':'#5CFFB8','--blue':'#5CC8FF','--purple':'#8A7FFF',
        '--pink':'#B87FFF','--lime':'#B0FF5C','--text':'#EAFFFC','--text-dim':'#7FC2C4' },
      titleGrad:'linear-gradient(90deg,#7FFFD4,#B87FFF)',
      colors:[
        {bg:'linear-gradient(135deg,#9EFFE0,#5CFFB8)'},{bg:'linear-gradient(135deg,#FFA8EC,#FF7FE0)'},
        {bg:'linear-gradient(135deg,#8ADCFF,#5CC8FF)'},{bg:'linear-gradient(135deg,#ADA3FF,#8A7FFF)'},
        {bg:'linear-gradient(135deg,#D0A8FF,#B87FFF)'},{bg:'linear-gradient(135deg,#CBFF8A,#B0FF5C)'},
        {bg:'linear-gradient(135deg,#A0FFE8,#7FFFD4)'}
      ] }
  ];

  // ===================== 🎰 ガチャ限定スキン(購入不可、ガチャでのみ入手可能。最も作り込んだスキン) =====================
  const GACHA_SKINS = [
    { id:'gacha_cosmicdragon', name:'🐉 コズミックドラゴン', price:0, gacha:true, gachaEffect:true,
      desc:'銀河の彼方より舞い降りし竜の鱗。虹色の輝きが盤面全体を包み込む、ガチャ限定の至宝。',
      vars:{ '--bg-deep':'#050318','--bg-deep2':'#0d0630','--panel':'#160b45','--panel-light':'#241259',
        '--gold':'#FFD700','--coral':'#FF3DBE','--mint':'#3DFFD0','--blue':'#3D8BFF','--purple':'#8A3DFF',
        '--pink':'#FF3DBE','--lime':'#B0FF3D','--text':'#F5F0FF','--text-dim':'#A995D9' },
      titleGrad:'linear-gradient(90deg,#FFD700,#FF3DBE,#3D8BFF)',
      colors:[
        {bg:'linear-gradient(135deg,#FFD700 0%,#FF9D3D 35%,#FF3DBE 70%,#8A3DFF 100%)'},
        {bg:'linear-gradient(135deg,#3DFFD0 0%,#3D8BFF 50%,#8A3DFF 100%)'},
        {bg:'linear-gradient(135deg,#FF3DBE 0%,#B03DFF 50%,#3D8BFF 100%)'},
        {bg:'linear-gradient(135deg,#3D8BFF 0%,#3DFFD0 50%,#B0FF3D 100%)'},
        {bg:'linear-gradient(135deg,#FFD700 0%,#FF3DBE 50%,#8A3DFF 100%)'},
        {bg:'linear-gradient(135deg,#B0FF3D 0%,#3DFFD0 50%,#3D8BFF 100%)'},
        {bg:'linear-gradient(135deg,#8A3DFF 0%,#FF3DBE 50%,#FFD700 100%)'}
      ] },
    { id:'gacha_celestialphoenix', name:'🔥 セレスティアルフェニックス', price:0, gacha:true, gachaEffect:true,
      desc:'天空を焦がして舞い上がる不死鳥の炎。触れれば燃え尽きるほどの熱を秘めた、ガチャ限定の伝説。',
      vars:{ '--bg-deep':'#1a0500','--bg-deep2':'#2e0a00','--panel':'#451400','--panel-light':'#5c1e00',
        '--gold':'#FFEC3D','--coral':'#FF4500','--mint':'#FFB03D','--blue':'#FF7A3D','--purple':'#FF2D55',
        '--pink':'#FF6B3D','--lime':'#FFD93D','--text':'#FFF6E9','--text-dim':'#D9A87F' },
      titleGrad:'linear-gradient(90deg,#FFEC3D,#FF4500,#FF2D55)',
      colors:[
        {bg:'linear-gradient(135deg,#FFEC3D 0%,#FFB03D 40%,#FF4500 80%,#FF2D55 100%)'},
        {bg:'linear-gradient(135deg,#FFD93D 0%,#FF7A3D 50%,#FF4500 100%)'},
        {bg:'linear-gradient(135deg,#FF4500 0%,#FF2D55 50%,#B0003D 100%)'},
        {bg:'linear-gradient(135deg,#FFEC3D 0%,#FF6B3D 50%,#FF2D55 100%)'},
        {bg:'linear-gradient(135deg,#FFB03D 0%,#FF4500 50%,#FF2D55 100%)'},
        {bg:'linear-gradient(135deg,#FFF6D0 0%,#FFEC3D 40%,#FF7A3D 100%)'},
        {bg:'linear-gradient(135deg,#FF2D55 0%,#FF4500 50%,#FFB03D 100%)'}
      ] },
    { id:'gacha_voidempress', name:'👑 ヴォイドエンプレス', price:0, gacha:true, gachaEffect:true,
      desc:'虚無を統べる女帝の威光。漆黒と紫銀の輝きが交差する、静謐にして絶対的な支配の証。',
      vars:{ '--bg-deep':'#020005','--bg-deep2':'#0a0512','--panel':'#150a26','--panel-light':'#221238',
        '--gold':'#E8D9FF','--coral':'#D63DFF','--mint':'#C9C9FF','--blue':'#7D3DFF','--purple':'#B03DFF',
        '--pink':'#FF3DDB','--lime':'#C9A8FF','--text':'#F5F0FF','--text-dim':'#9080B8' },
      titleGrad:'linear-gradient(90deg,#E8D9FF,#B03DFF,#D63DFF)',
      colors:[
        {bg:'linear-gradient(135deg,#E8D9FF 0%,#C9A8FF 40%,#B03DFF 80%,#3D0A5C 100%)'},
        {bg:'linear-gradient(135deg,#7D3DFF 0%,#3D0A5C 50%,#0A0018 100%)'},
        {bg:'linear-gradient(135deg,#D63DFF 0%,#B03DFF 50%,#5C0A8A 100%)'},
        {bg:'linear-gradient(135deg,#C9C9FF 0%,#7D3DFF 50%,#2E0050 100%)'},
        {bg:'linear-gradient(135deg,#FF3DDB 0%,#B03DFF 50%,#3D0A5C 100%)'},
        {bg:'linear-gradient(135deg,#E8D9FF 0%,#D63DFF 50%,#5C0A8A 100%)'},
        {bg:'linear-gradient(135deg,#3D0A5C 0%,#7D3DFF 50%,#E8D9FF 100%)'}
      ] }
  ];
  SKINS.push(...GACHA_SKINS);

  // ===================== 模様入りスキンを自動生成（既存パレット×パターンの組み合わせ）=====================
  // 通常スキンより高価に設定し、ボードの各ブロックに柄（ストライプ・ドットなど）を重ねて描画する
  (function generatePatternedSkins(){
    const plainSkins = SKINS.filter(s=>!s.gacha); // ガチャ限定スキンは柄違いバージョンを作らない(購入不可のまま維持)
    const patternKeys = Object.keys(PATTERN_LAYERS);
    plainSkins.forEach((base, i)=>{
      const patternKey = patternKeys[i % patternKeys.length];
      SKINS.push({
        id: `${base.id}-${patternKey}`,
        name: `${base.name}（${PATTERN_LABELS[patternKey]}柄）`,
        price: Math.round(base.price * 2.3 + 600),
        desc: `${base.desc} ブロックに${PATTERN_LABELS[patternKey]}模様をあしらった特別バージョン。`,
        vars: base.vars,
        titleGrad: base.titleGrad,
        colors: base.colors,
        pattern: patternKey
      });
    });
  })();
  let ownedSkins = ['default'];
  let equippedSkin = 'default';

  const SHAPES = [
    [[0,0]],[[0,0]],
    [[0,0],[0,1]],[[0,0],[0,1]],
    [[0,0],[1,0]],[[0,0],[1,0]],
    [[0,0],[0,1],[0,2]],[[0,0],[1,0],[2,0]],
    [[0,0],[1,0],[1,1]],[[0,0],[0,1],[1,0]],[[0,0],[0,1],[1,1]],[[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[0,2],[0,3]],[[0,0],[1,0],[2,0],[3,0]],
    [[0,0],[0,1],[1,0],[1,1]],[[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[0,2],[1,1]],[[1,0],[1,1],[1,2],[0,1]],
    [[0,0],[1,0],[2,0],[1,1]],[[0,1],[1,1],[2,1],[1,0]],
    [[0,0],[1,0],[2,0],[2,1]],[[0,1],[1,1],[2,1],[2,0]],
    [[0,1],[0,2],[1,0],[1,1]],[[0,0],[0,1],[1,1],[1,2]],
    [[0,1],[1,0],[1,1],[1,2],[2,1]],
    [[0,0],[0,1],[0,2],[0,3],[0,4]],[[0,0],[1,0],[2,0],[3,0],[4,0]],
    [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]]
  ];

  const boardEl = document.getElementById('board');
  const boardWrapEl = document.getElementById('board-wrap');
  const trayEl = document.getElementById('tray');
  const tetrisWrapEl = document.getElementById('tetris-wrap');
  const tetrisBoardEl = document.getElementById('tetrisBoard');
  const tetrisNextEl = document.getElementById('tetrisNext');
  const tetrisLevelEl = document.getElementById('tetrisLevel');
  const tetrisLinesEl = document.getElementById('tetrisLines');
  const tetrisComboTextEl = document.getElementById('tetrisComboText');
  const tBtnLeftEl = document.getElementById('tBtnLeft');
  const tBtnRightEl = document.getElementById('tBtnRight');
  const tBtnRotateEl = document.getElementById('tBtnRotate');
  const tBtnSoftEl = document.getElementById('tBtnSoft');
  const tBtnHardEl = document.getElementById('tBtnHard');
  const tBtnHoldEl = document.getElementById('tBtnHold');
  const tetrisHoldBoxEl = document.getElementById('tetrisHoldBox');
  const tetrisHelpBtnEl = document.getElementById('tetrisHelpBtn');
  const tetrisHelpPanelEl = document.getElementById('tetrisHelpPanel');
  const ghostEl = document.getElementById('ghost');
  const scoreValEl = document.getElementById('scoreVal');
  const bestValEl = document.getElementById('bestVal');
  const coinValEl = document.getElementById('coinVal');
  const timeAttackCardEl = document.getElementById('timeAttackCard');
  const timeAttackValEl = document.getElementById('timeAttackVal');
  const comboTextEl = document.getElementById('comboText');
  const overlayEl = document.getElementById('overlay');
  const finalScoreEl = document.getElementById('finalScore');
  const newBestNoteEl = document.getElementById('newBestNote');
  const coinEarnedNoteEl = document.getElementById('coinEarnedNote');
  const duelResultNoteEl = document.getElementById('duelResultNote');
  const restartBtn = document.getElementById('restartBtn');
  const soundBtn = document.getElementById('soundBtn');
  const questBtn = document.getElementById('questBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const modeBadgeEl = document.getElementById('modeBadge');
  const accountBtn = document.getElementById('accountBtn');
  const rankingBtn = document.getElementById('rankingBtn');
  const adminPanelBtn = document.getElementById('adminPanelBtn');
  const chatBtn = document.getElementById('chatBtn');
  const friendsBtn = document.getElementById('friendsBtn');
  const friendsDot = document.getElementById('friendsDot');
  const friendsMentionBadge = document.getElementById('friendsMentionBadge');
  const chatDot = document.getElementById('chatDot');
  const chatMentionBadge = document.getElementById('chatMentionBadge');
  const modalOverlay = document.getElementById('modalOverlay');
  const modalContent = document.getElementById('modalContent');
  const modalClose = document.getElementById('modalClose');

  let board = [], cellEls = [], tray = [];
  let score = 0, best = 0, coins = 0, streak = 0, noClearStreak = 0;
  let soundOn = true;
  let soundVolume = 1;
  let darkMode = true;
  const STORAGE_APPSETTINGS = 'candyblast-appsettings-v1';
  async function loadAppSettings(){
    try{
      const res = await appStorage.get(STORAGE_APPSETTINGS, false);
      if(res && res.value){
        const parsed = JSON.parse(res.value);
        if(typeof parsed.soundVolume === 'number') soundVolume = parsed.soundVolume;
        if(typeof parsed.darkMode === 'boolean') darkMode = parsed.darkMode;
        if(typeof parsed.soundOn === 'boolean') soundOn = parsed.soundOn;
      }
    }catch(err){}
    applyDarkMode();
  }
  async function saveAppSettings(){
    try{ await appStorage.set(STORAGE_APPSETTINGS, JSON.stringify({soundVolume, darkMode, soundOn}), false); }catch(err){}
  }
  function applyDarkMode(){
    if(darkMode){
      document.documentElement.style.removeProperty('--bg-deep');
      document.documentElement.style.removeProperty('--bg-deep2');
      document.documentElement.style.removeProperty('--panel');
      document.documentElement.style.removeProperty('--panel-light');
      document.documentElement.style.removeProperty('--text');
      document.documentElement.style.removeProperty('--text-dim');
      applySkin(equippedSkin || 'default');
    } else {
      // ライトモード: 明るい配色に切り替え(ブロックの色自体はスキンのまま)
      document.documentElement.style.setProperty('--bg-deep', '#EDE7F6');
      document.documentElement.style.setProperty('--bg-deep2', '#F5F1FA');
      document.documentElement.style.setProperty('--panel', '#FFFFFF');
      document.documentElement.style.setProperty('--panel-light', '#F1EDF9');
      document.documentElement.style.setProperty('--text', '#2A1E38');
      document.documentElement.style.setProperty('--text-dim', '#8A7B9C');
    }
  }
  let dragState = null;

  let adminDisabledBlocks = [];
  let adminSafetyMode = false;

  const DAILY_STATS_DEFAULT = { linesCleared:0, piecesPlaced:0, combos:0, gamesPlayed:0, scoreEarned:0,
    bestSingleGameScore:0, tripleClearCount:0, maxComboStreak:0, hardModeGamesPlayed:0, maxNoClearStreak:0, bigPiecesPlaced:0 };
  let dailyStats = { ...DAILY_STATS_DEFAULT };
  let activeQuests = [];
  let questsCompletedCount = 0;

  let pendingMode = currentMode, pendingSize = SIZE;
  let authToken = null;
  const COOKIE_AUTH = 'candyblast_auth';
  async function saveAuthSession(token, id){
    try{ setCookie(COOKIE_AUTH, JSON.stringify({token, id}), 30); }catch(err){}
  }
  async function clearAuthSession(){
    try{ deleteCookie(COOKIE_AUTH); }catch(err){}
  }
  async function loadAuthSession(){
    try{
      const raw = getCookie(COOKIE_AUTH);
      if(raw){
        const parsed = JSON.parse(raw);
        return parsed.token ? parsed : null;
      }
    }catch(err){}
    return null;
  }
  // リロード後も安全にログイン状態を復元する。
  // トークンをローカルに保存し、起動時にサーバーへ検証リクエストを送って
  // 有効な場合のみ復元(無効/期限切れなら破棄してゲスト状態に戻す)。
  async function restoreSession(){
    const saved = await loadAuthSession();
    if(!saved) return false;
    authToken = saved.token;
    currentUserId = saved.id;
    try{
      const r = await fetch(`${API_BASE_URL}/api/sync`, { headers:{ 'Authorization':`Bearer ${authToken}` } });
      if(!r.ok) throw new Error('invalid session');
      const data = await r.json();
      applySyncData(data);
      updateAccountButton();
      startPlayTimeTracking();
      startUserSync();
      return true;
    }catch(err){
      authToken = null; currentUserId = null;
      await clearAuthSession();
      return false;
    }
  }
  let currentUserId = null;
  let playTime = 0;
  let playTimeInterval = null;

  // モード別ベストスコア
  let bestScores = { soft:0, baked:0, hard:0, extreme:0 };

  const STORAGE_BEST = 'candyblast-highscore';
  const STORAGE_BEST_SCORES = 'candyblast-bestScores-v1';
  const STORAGE_COINS = 'candyblast-coins';
  const STORAGE_QUESTS = 'candyblast-quests-v2';
  const STORAGE_SETTINGS = 'candyblast-settings-v1';
  const STORAGE_SKINS = 'candyblast-skins-v1';

  // ===================== ランキング用 =====================
  const RANKING_MODES = ['soft', 'baked', 'hard', 'extreme', 'tetris', 'timeattack'];
  const RANKING_MODE_LABELS = {
    soft: '🍮 柔らかい',
    baked: '🍪 焼成',
    hard: '🍬 硬い',
    extreme: '🧊 激硬',
    tetris: '🧱 テトリス',
    timeattack: '⏱ タイムアタック'
  };
  let currentRankingMode = 'soft';

  const RANKING_TYPES = ['score', 'coins', 'playtime'];
  const RANKING_TYPE_LABELS = {
    score: '🏆 スコア',
    coins: '🪙 コイン',
    playtime: '⏱️ プレイ時間'
  };
  let currentRankingType = 'score';
  let rankingPollInterval = null;
  let userSyncInterval = null;

  // ===================== ログイン中のユーザーデータをリアルタイム同期 =====================
  // 管理者コマンドでコインやスコアを変更されたときも、
  // 再ログインしなくても画面に反映されるように定期的にサーバーから取得する
  function startUserSync() {
    if (userSyncInterval) return;
    userSyncInterval = setInterval(() => { syncFromServer(); }, 5000);
  }
  function stopUserSync() {
    if (userSyncInterval) { clearInterval(userSyncInterval); userSyncInterval = null; }
  }

  function boardIndex(r,c){ return r*SIZE+c; }
  function todayKey(){ return new Date().toISOString().slice(0,10); }

  // ===================== プレイ時間計測 =====================
  function startPlayTimeTracking() {
    if (playTimeInterval) return;
    playTimeInterval = setInterval(() => { playTime++; }, 1000);
  }
  function stopPlayTimeTracking() {
    if (playTimeInterval) { clearInterval(playTimeInterval); playTimeInterval = null; }
  }
  function syncPlayTime() {
    if (!authToken) return;
    fetch(`${API_BASE_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` },
      body: JSON.stringify({ playTime })
    }).catch(() => {});
  }

  // ===================== ボード初期化 =====================
  function initBoard(){
    boardEl.innerHTML = ''; board = []; cellEls = [];
    const gap = SIZE<=8 ? 4 : (SIZE<=12 ? 3 : 2);
    const radius = SIZE<=8 ? 7 : (SIZE<=12 ? 5 : 3);
    boardEl.style.gridTemplateColumns = `repeat(${SIZE},1fr)`;
    boardEl.style.gridTemplateRows = `repeat(${SIZE},1fr)`;
    boardEl.style.gap = gap+'px';
    for(let r=0;r<SIZE;r++){
      for(let c=0;c<SIZE;c++){
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.style.borderRadius = radius+'px';
        boardEl.appendChild(cell);
        cellEls.push(cell);
        board.push({filled:false, colorIdx:-1});
      }
    }
  }

  function updateModeBadge(){
    if(currentMode==='tetris'){ modeBadgeEl.textContent = '🧱 テトリス'; return; }
    if(currentMode==='timeattack'){ modeBadgeEl.textContent = '⏱ タイムアタック'; return; }
    const m = MODES[currentMode];
    if(m) modeBadgeEl.textContent = `${m.emoji} ${m.label} · ${SIZE}×${SIZE}`;
  }

  // ===================== タイムアタックモード =====================
  const TIME_ATTACK_DURATION = 60; // 秒
  let timeAttackTimeLeft = 0;
  let timeAttackInterval = null;

  function updateTimeAttackDisplay(){
    const m = Math.floor(Math.max(0,timeAttackTimeLeft)/60);
    const s = Math.max(0,timeAttackTimeLeft) % 60;
    timeAttackValEl.textContent = `${m}:${String(s).padStart(2,'0')}`;
    timeAttackCardEl.classList.toggle('urgent', timeAttackTimeLeft<=10);
  }

  function stopTimeAttackTimer(){
    if(timeAttackInterval){ clearInterval(timeAttackInterval); timeAttackInterval = null; }
    timeAttackCardEl.style.display = 'none';
  }

  function startTimeAttackTimer(){
    stopTimeAttackTimer();
    timeAttackTimeLeft = TIME_ATTACK_DURATION;
    timeAttackCardEl.style.display = 'flex';
    updateTimeAttackDisplay();
    timeAttackInterval = setInterval(()=>{
      timeAttackTimeLeft--;
      updateTimeAttackDisplay();
      if(timeAttackTimeLeft<=5 && timeAttackTimeLeft>0) playSound('timer');
      if(timeAttackTimeLeft<=0){
        stopTimeAttackTimer();
        endGame();
      }
    }, 1000);
  }

  function startTimeAttackMode(){
    if(currentMode==='tetris') exitTetrisMode();
    currentMode = 'timeattack';
    SIZE = 8;
    saveSettings();
    updateModeBadge();
    overlayEl.classList.remove('show');
    score = 0; streak = 0; noClearStreak = 0;
    updateScoreUI();
    initBoard();
    fillTray();
    startTimeAttackTimer();
  }

  // ===================== 🆕 週替わりチャレンジ(ランダムな難易度・盤面サイズ、週1回) =====================
  async function fetchWeeklyChallenge(){
    try{
      const headers = {};
      if(authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const r = await fetch(`${API_BASE_URL}/api/weekly-challenge`, { headers });
      return await r.json();
    }catch(err){ return null; }
  }

  async function openWeeklyChallengeModal(){
    modalContent.dataset.mode = 'weeklychallenge';
    modalContent.innerHTML = `<h2 style="color:var(--gold);">🎲 週替わりチャレンジ</h2><div class="empty-hint">読み込み中...</div>`;
    modalOverlay.classList.add('show');
    const data = await fetchWeeklyChallenge();
    if(!modalOverlay.classList.contains('show') || modalContent.dataset.mode!=='weeklychallenge') return;
    if(!data || !data.challenge){
      modalContent.innerHTML = `<h2 style="color:var(--gold);">🎲 週替わりチャレンジ</h2><div class="empty-hint">現在準備中です。しばらくお待ちください。</div>`;
      return;
    }
    const c = data.challenge;
    const modeLabel = (MODES[c.mode] && MODES[c.mode].label) || c.mode;
    let html = `<h2 style="color:var(--gold);">🎲 週替わりチャレンジ</h2>
      <div class="sub" style="margin-bottom:8px;">今週のお題: <b style="color:var(--mint);">${modeLabel} ${c.size}×${c.size}</b></div>
      <div class="sub">1人1回だけ挑戦できます。1位には🪙${formatNumber(c.reward)}コイン！</div>
      <div class="sub" style="color:var(--coral); font-weight:800; margin:6px 0 12px;">リセットまで: ${formatHMS(c.secondsUntilReset)}</div>`;
    if(!authToken){
      html += `<div class="empty-hint">挑戦するにはログインが必要です。</div>`;
    } else if(data.hasPlayed){
      html += `<div class="quest-item"><div class="qtitle">✅ 挑戦済み！ あなたのスコア: ${data.myScore}</div></div>`;
    } else {
      html += `<button class="primary-btn" id="weeklyChallengeStartBtn">🎲 挑戦する</button>`;
    }
    html += `<h3 style="color:var(--mint); margin:14px 0 8px;">🏆 ランキング TOP10</h3>`;
    if(!data.ranking || data.ranking.length===0){
      html += `<div class="empty-hint">まだ挑戦者がいません。一番乗りを目指そう！</div>`;
    } else {
      data.ranking.forEach((r,i)=>{
        html += `<div class="friend-item"><span class="fname">${i+1}. ${r.id}</span><span class="fsub">${r.score}点</span></div>`;
      });
    }
    modalContent.innerHTML = html;
    const startBtn = document.getElementById('weeklyChallengeStartBtn');
    if(startBtn) startBtn.addEventListener('click', ()=>{
      closeModal();
      startWeeklyChallenge(c);
    });
  }

  function startWeeklyChallenge(challenge){
    if(currentMode==='tetris') exitTetrisMode();
    if(currentMode==='timeattack') stopTimeAttackTimer();
    weeklyChallengeActive = true;
    weeklyChallengeInfo = challenge;
    currentMode = challenge.mode;
    SIZE = challenge.size;
    const modeLabel = (MODES[challenge.mode] && MODES[challenge.mode].label) || challenge.mode;
    modeBadgeEl.textContent = `🎲 週替わり: ${modeLabel} ${SIZE}×${SIZE}`;
    overlayEl.classList.remove('show');
    score = 0; streak = 0; noClearStreak = 0;
    scoreValEl.textContent = '0';
    initBoard();
    fillTray();
  }

  // ===================== 🎰 ガチャ(限定スキン、天井あり) =====================
  async function fetchGachaState(){
    if(!authToken) return null;
    try{
      const r = await fetch(`${API_BASE_URL}/api/gacha/state`, { headers:{ 'Authorization':`Bearer ${authToken}` } });
      if(!r.ok) return null;
      return await r.json();
    }catch(err){ return null; }
  }

  async function openGachaModal(){
    modalContent.dataset.mode = 'gacha';
    if(!authToken){
      modalContent.innerHTML = `<h2 style="color:var(--gold);">🎰 ガチャ</h2><div class="empty-hint">ログインするとガチャに挑戦できます。</div>`;
      modalOverlay.classList.add('show');
      return;
    }
    modalContent.innerHTML = `<h2 style="color:var(--gold);">🎰 ガチャ</h2><div class="empty-hint">読み込み中...</div>`;
    modalOverlay.classList.add('show');
    const state = await fetchGachaState();
    if(!modalOverlay.classList.contains('show') || modalContent.dataset.mode!=='gacha') return;
    renderGachaModal(state);
  }

  function renderGachaModal(state){
    if(!state){
      modalContent.innerHTML = `<h2 style="color:var(--gold);">🎰 ガチャ</h2><div class="empty-hint">読み込みに失敗しました。</div>`;
      return;
    }
    const pityPct = Math.min(100, Math.round((state.pityCounter / state.pityThreshold) * 100));
    const gachaSkinCards = GACHA_SKINS.map(s=>`
      <div class="skin-swatches" style="margin-bottom:2px;">${buildPatternedColors(s.colors).slice(0,4).map(c=>`<span class="swatch" style="background:${c.bg}"></span>`).join('')}</div>
    `).join('');
    let html = `
      <h2 style="color:var(--gold);">🎰 ガチャ</h2>
      <div class="sub" style="margin-bottom:8px;">1回 🪙${formatNumber(state.cost)}。低確率でガチャ限定スキンが手に入ります(被った場合は🪙${formatNumber(500)}に還元)。</div>
      <div class="quest-item" style="text-align:center;">
        <div class="qtitle">🐉🔥👑 ガチャ限定スキン</div>
        ${gachaSkinCards}
        <div class="sub" style="margin-top:6px;">天井: ${state.pityThreshold}回以内に必ず1つ獲得できます</div>
        <div class="quest-bar-bg" style="margin-top:8px;"><div class="quest-bar-fill" style="width:${pityPct}%"></div></div>
        <div class="sub" style="margin-top:4px;">天井まで: ${state.pityCounter} / ${state.pityThreshold}回</div>
      </div>
      <div class="sub" style="margin:8px 0; text-align:center;">🪙 所持: ${formatNumber(state.coins)}${state.freeTickets>0 ? ` ／ 🎫 無料チケット: ${state.freeTickets}枚` : ''}</div>
      <button class="primary-btn" id="gachaPullBtn" ${(state.coins<state.cost && !(state.freeTickets>0))?'disabled':''}>
        ${state.freeTickets>0 ? '🎫 無料チケットで引く' : `🎰 ${formatNumber(state.cost)}コインで引く`}
      </button>
      <div id="gachaResultArea" style="margin-top:10px;"></div>
    `;
    modalContent.innerHTML = html;
    document.getElementById('gachaPullBtn').addEventListener('click', performGachaPull);
  }

  async function performGachaPull(){
    const btn = document.getElementById('gachaPullBtn');
    const resultArea = document.getElementById('gachaResultArea');
    btn.disabled = true;
    resultArea.innerHTML = `<div class="empty-hint">🎰 抽選中...</div>`;
    try{
      const res = await fetch(`${API_BASE_URL}/api/gacha/pull`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` }
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || '抽選に失敗しました');

      if(data.resultType === 'win'){
        const skin = GACHA_SKINS.find(s=>s.id===data.skinId);
        ownedSkins = data.ownedSkins;
        saveSkinsData();
        playSound('coin');
        resultArea.innerHTML = `
          <div class="quest-item" style="text-align:center; border:2px solid var(--gold);">
            <div class="qtitle" style="font-size:16px;">${data.pityTriggered?'🎯 天井達成！':'🎉 大当たり！'}</div>
            <div class="skin-swatches" style="justify-content:center; margin:8px 0;">${buildPatternedColors(skin.colors).map(c=>`<span class="swatch" style="background:${c.bg}"></span>`).join('')}</div>
            <div style="font-weight:800;">${skin.name} を獲得しました！</div>
          </div>`;
      } else if(data.resultType === 'duplicate'){
        playSound('coin');
        const skin = GACHA_SKINS.find(s=>s.id===data.skinId);
        resultArea.innerHTML = `<div class="quest-item" style="text-align:center;">
          <div class="qtitle">${skin.name} が被りました…</div>
          <div class="sub">代わりに 🪙${formatNumber(data.coinsGained)} を獲得しました。</div>
        </div>`;
      } else {
        resultArea.innerHTML = `<div class="quest-item" style="text-align:center;">
          <div class="qtitle">残念、ハズレ…</div>
          <div class="sub">🪙${formatNumber(data.coinsGained)} を獲得しました。</div>
        </div>`;
      }

      coins = data.coins;
      updateCoinUI();
      renderGachaModal({
        coins: data.coins, totalPulls: data.totalPulls, pityCounter: data.pityCounter,
        pityThreshold: data.pityThreshold, cost: GACHA_COST_CLIENT, freeTickets: data.freeTickets, ownedSkins: data.ownedSkins
      });
      // 結果表示だけは上のresultAreaに残したいので再度差し込む
      document.getElementById('gachaResultArea').innerHTML = resultArea.innerHTML;
    }catch(err){
      resultArea.innerHTML = `<div class="empty-hint">${err.message}</div>`;
      btn.disabled = false;
    }
  }
  const GACHA_COST_CLIENT = 300; // サーバー側のGACHA_COSTと合わせておくための表示用フォールバック

  // ===================== 🎫 バトルパス(経験値でレベルアップ、報酬はループ、レベル上限なし) =====================
  async function fetchBattlePassState(){
    if(!authToken) return null;
    try{
      const r = await fetch(`${API_BASE_URL}/api/battlepass/state`, { headers:{ 'Authorization':`Bearer ${authToken}` } });
      if(!r.ok) return null;
      return await r.json();
    }catch(err){ return null; }
  }

  async function openBattlePassModal(){
    modalContent.dataset.mode = 'battlepass';
    if(!authToken){
      modalContent.innerHTML = `<h2 style="color:var(--gold);">🎫 バトルパス</h2><div class="empty-hint">ログインするとバトルパスに参加できます。</div>`;
      modalOverlay.classList.add('show');
      return;
    }
    modalContent.innerHTML = `<h2 style="color:var(--gold);">🎫 バトルパス</h2><div class="empty-hint">読み込み中...</div>`;
    modalOverlay.classList.add('show');
    const state = await fetchBattlePassState();
    if(!modalOverlay.classList.contains('show') || modalContent.dataset.mode!=='battlepass') return;
    renderBattlePassModal(state);
  }

  function battlePassRewardLabel(reward){
    if(reward.type==='coins') return `🪙 ${formatNumber(reward.amount)}コイン`;
    if(reward.type==='gacha_ticket') return `🎫 ガチャ無料チケット×${reward.amount}`;
    return '???';
  }

  function renderBattlePassModal(state){
    if(!state){
      modalContent.innerHTML = `<h2 style="color:var(--gold);">🎫 バトルパス</h2><div class="empty-hint">読み込みに失敗しました。</div>`;
      return;
    }
    const pct = Math.round((state.xpIntoLevel / state.xpPerLevel) * 100);
    let html = `
      <h2 style="color:var(--gold);">🎫 バトルパス</h2>
      <div class="sub" style="margin-bottom:8px;">ゲームをプレイして経験値を貯めよう。レベル上限はなく、報酬は10レベルごとにループします。</div>
      <div class="quest-item" style="text-align:center;">
        <div class="qtitle" style="font-size:20px;">Lv. ${state.level}</div>
        <div class="quest-bar-bg" style="margin-top:8px;"><div class="quest-bar-fill" style="width:${pct}%"></div></div>
        <div class="sub" style="margin-top:4px;">${state.xpIntoLevel} / ${state.xpPerLevel} XP</div>
      </div>
      <h3 style="color:var(--mint); margin:14px 0 8px;">🎁 報酬一覧</h3>
    `;
    state.rewards.slice().reverse().forEach(r=>{
      html += `
        <div class="quest-item">
          <div class="quest-foot">
            <span>Lv.${r.level} — ${battlePassRewardLabel(r)}</span>
            <button class="claim-btn" data-bplevel="${r.level}" ${r.claimed?'disabled':''}>${r.claimed?'受取済み':'受け取る'}</button>
          </div>
        </div>`;
    });
    modalContent.innerHTML = html;
    modalContent.querySelectorAll('[data-bplevel]').forEach(btn=>{
      btn.addEventListener('click', ()=>claimBattlePassLevel(parseInt(btn.dataset.bplevel)));
    });
  }

  async function claimBattlePassLevel(level){
    try{
      const res = await fetch(`${API_BASE_URL}/api/battlepass/claim`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` },
        body: JSON.stringify({ level })
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error);
      coins = data.coins;
      updateCoinUI();
      playSound('coin');
      const state = await fetchBattlePassState();
      renderBattlePassModal(state);
    }catch(err){
      alert(err.message);
    }
  }

  // ゲームプレイに応じてバトルパスの経験値を加算する(スコア10点=1XP換算、サーバー側でも上限チェックあり)
  function grantBattlePassXp(scoreGained){
    if(!authToken || scoreGained<=0) return;
    const xp = Math.floor(scoreGained / 10);
    if(xp<=0) return;
    fetch(`${API_BASE_URL}/api/battlepass/addxp`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` },
      body: JSON.stringify({ amount: xp })
    }).catch(()=>{});
  }

  function applyMode(mode, size){
    if(mode==='tetris'){
      enterTetrisMode();
      return;
    }
    if(mode==='timeattack'){
      startTimeAttackMode();
      return;
    }
    if(currentMode==='tetris') exitTetrisMode();
    if(currentMode==='timeattack') stopTimeAttackTimer();
    currentMode = MODES[mode] ? mode : 'baked';
    SIZE = (currentMode==='extreme') ? 8 : Math.min(18, Math.max(5, size||8));
    saveSettings();
    updateModeBadge();
    overlayEl.classList.remove('show');
    score = 0; streak = 0; noClearStreak = 0;
    updateScoreUI();
    initBoard();
    fillTray();
  }

  function randomShapeColor(shape){
    return { shape, colorIdx: Math.floor(Math.random()*COLORS.length), used:false };
  }

  function boardFullnessRatio(){
    let filled = 0;
    for(let i=0;i<board.length;i++) if(board[i].filled) filled++;
    return filled / board.length;
  }

  function countValidPlacements(shape, pool){
    const shapes = pool || SHAPES;
    let count = 0;
    for(let r=0;r<SIZE;r++){
      for(let c=0;c<SIZE;c++){
        if(canPlaceAt(shape, r, c)) count++;
      }
    }
    return count;
  }

  function pickAdaptiveShape(aggressive, pool){
    const shapes = pool || SHAPES;
    const fullness = boardFullnessRatio();
    const threshold = aggressive ? 0.12 : 0.4;
    const maxBias = aggressive ? 6.0 : 3.2;
    const biasPower = fullness < threshold ? (aggressive ? 1.4 : 0) : ((fullness - threshold) / (1 - threshold)) * maxBias;
    if(biasPower <= 0) return shapes[Math.floor(Math.random()*shapes.length)];
    let totalWeight = 0;
    const weights = shapes.map(shape=>{
      const validCount = countValidPlacements(shape, shapes);
      const sizeBonus = 1 / shape.length;
      const weight = Math.pow(validCount + 0.05, biasPower) * (1 + sizeBonus);
      totalWeight += weight;
      return weight;
    });
    let r = Math.random() * totalWeight;
    for(let i=0;i<shapes.length;i++){
      r -= weights[i];
      if(r <= 0) return shapes[i];
    }
    return shapes[shapes.length-1];
  }

  function pickWeightedBigShape(pool){
    const shapes = pool || SHAPES;
    let totalWeight = 0;
    const weights = shapes.map(shape=>{
      const w = Math.pow(shape.length, 2.2);
      totalWeight += w;
      return w;
    });
    let r = Math.random() * totalWeight;
    for(let i=0;i<shapes.length;i++){
      r -= weights[i];
      if(r <= 0) return shapes[i];
    }
    return shapes[shapes.length-1];
  }

  function pickShapeForMode(pool){
    const shapes = pool || SHAPES;
    if(currentMode==='soft') return pickAdaptiveShape(true, shapes);
    if(currentMode==='hard') return shapes[Math.floor(Math.random()*shapes.length)];
    if(currentMode==='extreme') return pickWeightedBigShape(shapes);
    return pickAdaptiveShape(false, shapes);
  }

  function ensurePlayable(){
    if(currentMode==='hard' || currentMode==='extreme') return;
    if(currentMode==='soft'){
      tray.forEach((p,i)=>{
        if(p.used || anyValidPlacement(p.shape)) return;
        let bestShape = null, bestCount = -1;
        SHAPES.forEach(shape=>{
          const c = countValidPlacements(shape);
          if(c > bestCount){ bestCount = c; bestShape = shape; }
        });
        if(bestShape && bestCount > 0) tray[i] = randomShapeColor(bestShape);
      });
      return;
    }
    const anyFits = tray.some(p => !p.used && anyValidPlacement(p.shape));
    if(anyFits) return;
    let bestShape = null, bestCount = -1;
    SHAPES.forEach(shape=>{
      const c = countValidPlacements(shape);
      if(c > bestCount){ bestCount = c; bestShape = shape; }
    });
    if(bestShape && bestCount > 0) tray[0] = randomShapeColor(bestShape);
  }

  function fillTray(){
    let availableShapes = SHAPES;
    if (currentUserId === 'admin' && adminDisabledBlocks.length > 0) {
      availableShapes = SHAPES.filter((_, idx) => !adminDisabledBlocks.includes(idx));
      if (availableShapes.length === 0) availableShapes = SHAPES;
    }
    tray = [
      randomShapeColor(pickShapeForMode(availableShapes)),
      randomShapeColor(pickShapeForMode(availableShapes)),
      randomShapeColor(pickShapeForMode(availableShapes))
    ];
    ensurePlayable();
    renderTray();
    setTimeout(checkGameOver, 50);
  }

  function shapeBounds(shape){
    let maxR=0, maxC=0;
    shape.forEach(([r,c])=>{ maxR=Math.max(maxR,r); maxC=Math.max(maxC,c); });
    return {rows:maxR+1, cols:maxC+1};
  }

  function renderTray(){
    trayEl.innerHTML = '';
    tray.forEach((piece, idx)=>{
      const slot = document.createElement('div');
      slot.className = 'tray-slot';
      slot.dataset.idx = idx;
      if(!piece.used){
        const {rows, cols} = shapeBounds(piece.shape);
        const cellPx = Math.max(14, Math.min(24, Math.floor(68/Math.max(rows,cols))));
        const grid = document.createElement('div');
        grid.className = 'piece-grid';
        grid.style.gridTemplateColumns = `repeat(${cols}, ${cellPx}px)`;
        grid.style.gridTemplateRows = `repeat(${rows}, ${cellPx}px)`;
        for(let r=0;r<rows;r++){
          for(let c=0;c<cols;c++){
            const filled = piece.shape.some(([sr,sc])=>sr===r&&sc===c);
            const cd = document.createElement('div');
            cd.className = 'piece-cell' + (filled?'':' empty');
            if(filled) cd.style.background = COLORS[piece.colorIdx].bg;
            grid.appendChild(cd);
          }
        }
        slot.appendChild(grid);
        slot.addEventListener('pointerdown', (e)=>startDrag(e, idx));
      }
      trayEl.appendChild(slot);
    });
  }

  function canPlaceAt(shape, baseR, baseC){
    for(const [dr,dc] of shape){
      const r = baseR+dr, c = baseC+dc;
      if(r<0||r>=SIZE||c<0||c>=SIZE) return false;
      if(board[boardIndex(r,c)].filled) return false;
    }
    return true;
  }
  function anyValidPlacement(shape){
    if(!Array.isArray(shape) || shape.length===0) return false; // 空/不正な形状は「置ける場所なし」として扱う(以前はtrueになりゲームオーバーを妨げていた)
    for(let r=0;r<SIZE;r++) for(let c=0;c<SIZE;c++) if(canPlaceAt(shape,r,c)) return true;
    return false;
  }
  function checkGameOver(){
    try{
      if (currentUserId === 'admin' && adminSafetyMode) {
        if (tray.every(p => p.used)) fillTray();
        return;
      }
      const remaining = tray.filter(p=>!p.used);
      const stillPossible = remaining.some(p=>anyValidPlacement(p.shape));
      if(!stillPossible && remaining.length>0) endGame();
    }catch(err){
      // ここで例外が起きて握りつぶされると「盤面が埋まっているのにゲームオーバーにならない」
      // という不具合になるため、必ずログを残しつつ、安全側(ゲームオーバー扱い)に倒す
      console.error('checkGameOverでエラーが発生しました:', err);
      const remaining = (tray||[]).filter(p=>p && !p.used);
      if(remaining.length>0) endGame();
    }
  }

  // ===================== ドラッグ操作 =====================
  function startDrag(e, trayIdx){
    e.preventDefault();
    unlockAudio();
    const piece = tray[trayIdx];
    if(!piece || piece.used) return;
    const boardRect = boardEl.getBoundingClientRect();
    const cellSize = (boardRect.width - 16) / SIZE;
    const {rows, cols} = shapeBounds(piece.shape);
    dragState = { trayIdx, piece, cellSize, boardRect, grabDX: cellSize*0.5, grabDY: cellSize*0.5 + 46, lastValid:false, lastR:-1, lastC:-1 };
    const slot = trayEl.querySelector(`.tray-slot[data-idx="${trayIdx}"]`);
    if(slot) slot.classList.add('dragging-source');
    ghostEl.innerHTML = '';
    ghostEl.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
    ghostEl.style.gridTemplateRows = `repeat(${rows}, ${cellSize}px)`;
    for(let r=0;r<rows;r++){
      for(let c=0;c<cols;c++){
        const filled = piece.shape.some(([sr,sc])=>sr===r&&sc===c);
        const gd = document.createElement('div');
        gd.className = 'ghost-cell' + (filled?'':' empty');
        if(filled) gd.style.background = COLORS[piece.colorIdx].bg;
        ghostEl.appendChild(gd);
      }
    }
    ghostEl.style.display = 'grid';
    updateGhostPosition(e.clientX, e.clientY);
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
  }

  function updateGhostPosition(x,y){
    ghostEl.style.left = (x - dragState.grabDX) + 'px';
    ghostEl.style.top = (y - dragState.grabDY) + 'px';
  }

  function onDragMove(e){
    if(!dragState) return;
    updateGhostPosition(e.clientX, e.clientY);
    const rect = dragState.boardRect, cs = dragState.cellSize;
    const relX = (e.clientX - dragState.grabDX) - (rect.left+8);
    const relY = (e.clientY - dragState.grabDY) - (rect.top+8);
    const baseC = Math.round(relX / cs), baseR = Math.round(relY / cs);
    const valid = canPlaceAt(dragState.piece.shape, baseR, baseC);
    clearPreview();
    dragState.piece.shape.forEach(([dr,dc])=>{
      const r=baseR+dr, c=baseC+dc;
      if(r>=0&&r<SIZE&&c>=0&&c<SIZE) cellEls[boardIndex(r,c)].classList.add(valid?'preview-ok':'preview-bad');
    });
    dragState.lastValid = valid; dragState.lastR = baseR; dragState.lastC = baseC;
  }
  function clearPreview(){ cellEls.forEach(cell=>cell.classList.remove('preview-ok','preview-bad')); }

  function onDragEnd(e){
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    if(!dragState) return;
    const {piece, trayIdx, lastValid, lastR, lastC} = dragState;
    clearPreview();
    ghostEl.style.display = 'none';
    const slot = trayEl.querySelector(`.tray-slot[data-idx="${trayIdx}"]`);
    if(slot) slot.classList.remove('dragging-source');
    if(lastValid) commitPlacement(piece, lastR, lastC, trayIdx);
    dragState = null;
  }

  function commitPlacement(piece, baseR, baseC, trayIdx){
    piece.shape.forEach(([dr,dc])=>{
      const r=baseR+dr, c=baseC+dc, idx = boardIndex(r,c);
      board[idx] = {filled:true, colorIdx:piece.colorIdx};
      const cellEl = cellEls[idx];
      cellEl.className = 'cell filled just-placed';
      cellEl.style.background = COLORS[piece.colorIdx].bg;
    });
    playSound('place');
    addScore(piece.shape.length * 10);
    dailyStats.piecesPlaced += 1;
    if(piece.shape.length >= 5) dailyStats.bigPiecesPlaced = (dailyStats.bigPiecesPlaced||0) + 1;
    tray[trayIdx].used = true;
    renderTray();
    setTimeout(()=>{ resolveLines(); }, 80);
  }

  function resolveLines(){
    const fullRows = [], fullCols = [];
    for(let r=0;r<SIZE;r++){ let full=true; for(let c=0;c<SIZE;c++) if(!board[boardIndex(r,c)].filled){ full=false; break; } if(full) fullRows.push(r); }
    for(let c=0;c<SIZE;c++){ let full=true; for(let r=0;r<SIZE;r++) if(!board[boardIndex(r,c)].filled){ full=false; break; } if(full) fullCols.push(c); }
    const linesCleared = fullRows.length + fullCols.length;
    if(linesCleared>0){
      streak++;
      noClearStreak = 0;
      dailyStats.linesCleared += linesCleared;
      dailyStats.maxComboStreak = Math.max(dailyStats.maxComboStreak||0, streak);
      if(linesCleared>=2) dailyStats.combos += 1;
      if(linesCleared>=3) dailyStats.tripleClearCount = (dailyStats.tripleClearCount||0) + 1;
      const cellsToClear = new Set();
      fullRows.forEach(r=>{ for(let c=0;c<SIZE;c++) cellsToClear.add(boardIndex(r,c)); });
      fullCols.forEach(c=>{ for(let r=0;r<SIZE;r++) cellsToClear.add(boardIndex(r,c)); });
      cellsToClear.forEach(idx=>{ cellEls[idx].classList.add('clearing'); spawnConfetti(cellEls[idx], linesCleared); });
      playSound('clear', linesCleared);
      // ===== コンボ倍率(連続でライン消去するほどスコア倍率が上がる。効果はスコア倍率のみ) =====
      const lineScore = linesCleared*100*linesCleared;
      const comboMultiplier = Math.min(4, 1 + (streak-1)*0.25);
      const totalLineScore = Math.round(lineScore * comboMultiplier);
      addScore(totalLineScore);
      showCombo(linesCleared, streak, comboMultiplier);
      updateQuestProgress();

      // 派手な演出: 大きめコンボでは画面シェイク＋衝撃波リング
      if(linesCleared>=2 || streak>=3){
        boardWrapEl.classList.remove('shake'); void boardWrapEl.offsetWidth; boardWrapEl.classList.add('shake');
        spawnShockRing();
      }

      const totalFilled = board.reduce((sum, cell) => sum + (cell.filled ? 1 : 0), 0);
      if (totalFilled === 0 && linesCleared > 0) {
        const bonus = linesCleared * 800 + 1500 + streak * 200;
        addScore(bonus);
        showComboText(`✨ 全消しボーナス +${bonus}点!`);
        spawnAllClearCelebration();
      }

      setTimeout(()=>{
        cellsToClear.forEach(idx=>{ board[idx] = {filled:false, colorIdx:-1}; cellEls[idx].className='cell'; cellEls[idx].style.background=''; });
        if(tray.every(p=>p.used)) fillTray(); else checkGameOver();
      }, 360);
    } else {
      streak = 0;
      noClearStreak++;
      dailyStats.maxNoClearStreak = Math.max(dailyStats.maxNoClearStreak||0, noClearStreak);
      if(tray.every(p=>p.used)) fillTray(); else checkGameOver();
    }
  }

  function showCombo(linesCleared, streakVal, multiplier){
    if(linesCleared<2 && streakVal<2) return;
    let msg = '';
    if(linesCleared>=2) msg = `COMBO x${linesCleared}!`;
    if(streakVal>=2) msg += (msg?'  ':'') + `🔥x${streakVal}`;
    if(multiplier && multiplier>1) msg += (msg?'  ':'') + `倍率×${multiplier.toFixed(2)}`;
    comboTextEl.textContent = msg;
    // 大きいコンボほど文字を派手に大きく・強調
    const bigness = Math.min(1.6, 1 + (Math.max(linesCleared,streakVal)-1)*0.12);
    comboTextEl.style.setProperty('--combo-scale', bigness);
    comboTextEl.className = 'combo-text show' + (Math.max(linesCleared,streakVal)>=4 ? ' mega' : '');
    setTimeout(() => { comboTextEl.className = 'combo-text'; }, 900);
  }

  function showComboText(msg){
    comboTextEl.textContent = msg;
    comboTextEl.className = 'combo-text bonus show mega';
    setTimeout(() => { comboTextEl.className = 'combo-text'; }, 900);
  }

  function spawnConfetti(cellEl, intensity){
    const rect = cellEl.getBoundingClientRect();
    const cx = rect.left+rect.width/2, cy = rect.top+rect.height/2;
    const count = 5 + Math.min(10, (intensity||1)*3);
    for(let i=0;i<count;i++){
      const p = document.createElement('div');
      p.className='confetti';
      p.style.background = COLORS[Math.floor(Math.random()*COLORS.length)].bg;
      p.style.left=cx+'px'; p.style.top=cy+'px';
      const size = 6 + Math.random()*6;
      p.style.width = size+'px'; p.style.height = size+'px';
      const angle=Math.random()*Math.PI*2, dist=40+Math.random()*(70+((intensity||1)*8));
      p.style.setProperty('--dx', Math.cos(angle)*dist+'px');
      p.style.setProperty('--dy', Math.sin(angle)*dist+'px');
      p.style.setProperty('--rot', (Math.random()*720-360)+'deg');
      p.style.animation=`confettiBurst ${0.5+Math.random()*0.3}s ease-out forwards`;
      document.body.appendChild(p);
      setTimeout(()=>p.remove(),900);
    }
  }

  function spawnShockRing(){
    if(!boardWrapEl) return;
    const ring = document.createElement('div');
    ring.className = 'shock-ring';
    boardWrapEl.appendChild(ring);
    setTimeout(()=>ring.remove(), 650);
  }

  // ===================== 全消し演出（画面フラッシュ＋大量紙吹雪＋星） =====================
  function spawnAllClearCelebration(){
    playSound('clear');
    const flash = document.createElement('div');
    flash.className = 'screen-flash';
    document.body.appendChild(flash);
    setTimeout(()=>flash.remove(), 600);

    const rect = boardWrapEl ? boardWrapEl.getBoundingClientRect() : {left:innerWidth/2, top:innerHeight/2, width:0, height:0};
    const cx = rect.left+rect.width/2, cy = rect.top+rect.height/2;
    const stars = ['✨','⭐','🍬','🎉','💫'];
    for(let i=0;i<28;i++){
      const s = document.createElement('div');
      s.className = 'star-particle';
      s.textContent = stars[Math.floor(Math.random()*stars.length)];
      const angle = Math.random()*Math.PI*2, dist = 60+Math.random()*220;
      s.style.setProperty('--sx0', '0px'); s.style.setProperty('--sy0','0px');
      s.style.setProperty('--sx1', Math.cos(angle)*dist+'px');
      s.style.setProperty('--sy1', Math.sin(angle)*dist+'px');
      s.style.left = cx+'px'; s.style.top = cy+'px';
      s.style.animationDelay = (Math.random()*0.15)+'s';
      document.body.appendChild(s);
      setTimeout(()=>s.remove(), 1000);
    }
    for(let i=0;i<3;i++){
      setTimeout(()=>spawnShockRing(), i*120);
    }
    if(boardWrapEl){
      boardWrapEl.classList.remove('shake'); void boardWrapEl.offsetWidth; boardWrapEl.classList.add('shake');
    }
  }

  function floatCoin(amount){
    const rect = boardEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className='coin-float';
    el.textContent = `+${amount}🪙`;
    el.style.left = (rect.left+rect.width/2-20)+'px';
    el.style.top = (rect.top+rect.height/2)+'px';
    el.style.animation='coinFloat 0.9s ease-out forwards';
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),950);
  }

  // ===================== スコア周り（リアルタイム同期対応） =====================
  let lastSyncTime = 0;
  let weeklyChallengeActive = false;
  let weeklyChallengeInfo = null;

  function syncBestScore() {
    if (!authToken || weeklyChallengeActive) return; // 週替わりチャレンジは通常のベストスコアを汚さない
    // 現在のモードのベストを更新
    const currentBest = bestScores[currentMode] || 0;
    if (score > currentBest) {
      bestScores[currentMode] = score;
      if (isRegularMode(currentMode)) {
        // 全体ベストも更新（表示用）
        best = Math.max(best, score);
        bestValEl.textContent = best;
      } else {
        animateNumberTo(bestValEl, score);
      }
      saveBestScores();
      // サーバーへ送信（スロットリング: 2秒に1回まで）
      const now = Date.now();
      if (now - lastSyncTime > 2000) {
        lastSyncTime = now;
        syncToServer();
      }
    }
  }

  let sessionScoreForXp = 0;
  function addScore(amount){
    score += amount;
    sessionScoreForXp += amount;
    dailyStats.scoreEarned += amount;
    dailyStats.bestSingleGameScore = Math.max(dailyStats.bestSingleGameScore||0, score);
    updateScoreUI();
    // リアルタイムでベストスコアを同期（必要に応じて）
    syncBestScore();
  }

  function isRegularMode(m){ return m==='soft' || m==='baked' || m==='hard' || m==='extreme'; }

  function updateScoreUI(){
    const curScore = parseInt(scoreValEl.textContent,10) || 0;
    if(score < curScore){ scoreValEl.textContent = score; } else { animateNumberTo(scoreValEl, score); }
    if(weeklyChallengeActive) return; // 週替わりチャレンジ中は通常のベスト表示を更新しない
    const curBest = parseInt(bestValEl.textContent,10) || 0;
    if(isRegularMode(currentMode)){
      const maxBest = Math.max(bestScores.soft, bestScores.baked, bestScores.hard, bestScores.extreme);
      if (maxBest > best) {
        best = maxBest;
        saveBestScores();
      }
      if(best < curBest){ bestValEl.textContent = best; } else { animateNumberTo(bestValEl, best); }
    } else {
      const modeBest = bestScores[currentMode] || 0;
      if(modeBest < curBest){ bestValEl.textContent = modeBest; } else { animateNumberTo(bestValEl, modeBest); }
    }
  }
  // コインなどの大きな数値を K/M/B/T 表記で見やすく表示する(内部の値自体は正確な数値のまま保持)
  function formatNumber(n){
    n = Number(n) || 0;
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const units = [ {v:1e15, s:'Q'}, {v:1e12, s:'T'}, {v:1e9, s:'B'}, {v:1e6, s:'M'}, {v:1e3, s:'K'} ];
    for(const u of units){
      if(abs >= u.v){
        const val = abs / u.v;
        const formatted = val >= 100 ? Math.floor(val) : (Math.round(val*10)/10);
        return sign + formatted + u.s;
      }
    }
    return sign + Math.floor(abs);
  }
  function updateCoinUI(){ coinValEl.textContent = formatNumber(coins); saveCoins(coins); }

  function awardGameEndCoins(){
    const earned = Math.floor((score/500) * coinMultiplier());
    if(earned>0){ coins += earned; updateCoinUI(); floatCoin(earned); }
    return earned;
  }

  // ===================== ベストスコア永続化 =====================
  async function loadBestScores(){
    try{
      const res = await appStorage.get(STORAGE_BEST_SCORES, false);
      if(res && res.value){
        const parsed = JSON.parse(res.value);
        if(parsed.soft !== undefined) bestScores = parsed;
      }
    }catch(err){}
    // 全体ベストは最大値
    best = Math.max(bestScores.soft, bestScores.baked, bestScores.hard, bestScores.extreme);
    bestValEl.textContent = best;
    tetrisBest = bestScores.tetris || 0;
  }
  async function saveBestScores(){
    try{ await appStorage.set(STORAGE_BEST_SCORES, JSON.stringify(bestScores), false); }catch(err){}
    // 全体ベストも保存（互換性のため）
    const overall = Math.max(bestScores.soft, bestScores.baked, bestScores.hard, bestScores.extreme);
    await saveBest(overall);
  }
  async function loadBest(){
    try{ const res = await appStorage.get(STORAGE_BEST, false); if(res && res.value) best = parseInt(res.value,10)||0; }catch(err){ best=0; }
    bestValEl.textContent = best;
  }
  async function saveBest(val){ try{ await appStorage.set(STORAGE_BEST, String(val), false); }catch(err){} }
  async function loadCoins(){
    try{ const res = await appStorage.get(STORAGE_COINS, false); if(res && res.value) coins = parseInt(res.value,10)||0; }catch(err){ coins=0; }
    coinValEl.textContent = formatNumber(coins);
  }
  async function saveCoins(val){ try{ await appStorage.set(STORAGE_COINS, String(val), false); }catch(err){} }

  // ===================== クエスト =====================
  const QUEST_POOL = [
    { id:'singleScore400', desc:'1回のプレイでスコア4000点以上を叩き出す', statKey:'bestSingleGameScore', target:4000, reward:50 },
    { id:'tripleClear', desc:'1回の設置で3ライン以上同時に消す(トリプルクリア)', statKey:'tripleClearCount', target:1, reward:70 },
    { id:'comboStreak4', desc:'1回のプレイでコンボストリークを4連続つなげる', statKey:'maxComboStreak', target:4, reward:65 },
    { id:'lines25', desc:'ラインを合計25本消す', statKey:'linesCleared', target:25, reward:55 },
    { id:'hardMode1', desc:'「硬い」以上の難易度でゲームを1回プレイし切る', statKey:'hardModeGamesPlayed', target:1, reward:45 },
    { id:'pieces60', desc:'ピースを合計60個配置する', statKey:'piecesPlaced', target:60, reward:40 },
    { id:'score600total', desc:'合計スコアを6000点稼ぐ', statKey:'scoreEarned', target:6000, reward:50 },
    { id:'noClearStreak10', desc:'ラインを消さずにピースを10個連続で置く我慢比べ', statKey:'maxNoClearStreak', target:10, reward:60 },
    { id:'bigPiece5', desc:'5マス以上の大きいブロックを5個配置する', statKey:'bigPiecesPlaced', target:5, reward:55 },
    { id:'play3', desc:'ゲームを3回プレイする', statKey:'gamesPlayed', target:3, reward:30 }
  ];

  function pickDailyQuests(){
    const pool = [...QUEST_POOL];
    const picked = [];
    for(let i=0;i<3 && pool.length>0;i++){
      const idx = Math.floor(Math.random()*pool.length);
      const q = pool.splice(idx,1)[0];
      picked.push({ ...q, progress:0, claimed:false });
    }
    return picked;
  }

  // ===================== 無限クエスト(エンドレス) =====================
  // クリアするたびにすぐ次のクエストが補充され、達成数が増えるほど目標値と報酬がじわじわ大きくなる
  function scaledTarget(base){
    return Math.max(1, Math.round(base * (1 + questsCompletedCount * 0.12)));
  }
  function scaledReward(base){
    return Math.round(base * (1 + questsCompletedCount * 0.15));
  }
  function issueNewQuest(excludePoolIds){
    const pool = QUEST_POOL.filter(q=>!excludePoolIds.includes(q.id));
    const poolItem = (pool.length ? pool : QUEST_POOL)[Math.floor(Math.random()*(pool.length ? pool.length : QUEST_POOL.length))];
    return {
      poolId: poolItem.id,
      desc: poolItem.desc,
      statKey: poolItem.statKey,
      baseline: dailyStats[poolItem.statKey] || 0,
      target: scaledTarget(poolItem.target),
      reward: scaledReward(poolItem.reward),
      claimed: false
    };
  }
  function ensureActiveQuests(){
    while(activeQuests.length < 3){
      const excludeIds = activeQuests.map(q=>q.poolId);
      activeQuests.push(issueNewQuest(excludeIds));
    }
  }
  function questProgressOf(q){
    return Math.max(0, (dailyStats[q.statKey] || 0) - q.baseline);
  }

  async function loadDailyQuests(){
    try{
      const res = await appStorage.get(STORAGE_QUESTS, false);
      if(res && res.value){
        const parsed = JSON.parse(res.value);
        dailyStats = { ...DAILY_STATS_DEFAULT, ...parsed.stats };
        questsCompletedCount = parsed.completedCount || 0;
        activeQuests = Array.isArray(parsed.active) ? parsed.active : [];
      }
    }catch(err){}
    ensureActiveQuests();
    await saveDailyQuests();
  }

  async function saveDailyQuests(){
    try{ await appStorage.set(STORAGE_QUESTS, JSON.stringify({stats:dailyStats, active:activeQuests, completedCount:questsCompletedCount}), false); }catch(err){}
  }

  function updateQuestProgress(){
    saveDailyQuests();
    if(modalOverlay.classList.contains('show') && modalContent.dataset.mode==='quests') renderQuestModal();
  }

  function claimQuest(poolId){
    const idx = activeQuests.findIndex(q=>q.poolId===poolId);
    if(idx===-1) return;
    const q = activeQuests[idx];
    if(q.claimed || questProgressOf(q) < q.target) return;
    coins += q.reward;
    updateCoinUI();
    questsCompletedCount += 1;
    activeQuests.splice(idx,1);
    ensureActiveQuests();
    saveDailyQuests();
    renderQuestModal();
    syncToServer();
  }

  function renderQuestModal(){
    modalContent.dataset.mode = 'quests';
    let html = `<h2 style="color:var(--mint);">📋 エンドレスクエスト</h2>
      <div class="sub">達成するとすぐ次のクエストが補充される、無限に挑戦し続けられるクエストです。通算<b style="color:var(--gold);">${questsCompletedCount}</b>個クリア中！</div>`;
    activeQuests.forEach(q=>{
      const progress = questProgressOf(q);
      const pct = Math.min(100, Math.floor((progress/q.target)*100));
      const done = progress >= q.target;
      html += `
        <div class="quest-item">
          <div class="qtitle">${q.desc}</div>
          <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div>
          <div class="quest-foot">
            <span>${Math.min(progress,q.target)} / ${q.target}</span>
            <button class="claim-btn" data-qid="${q.poolId}" ${(!done||q.claimed)?'disabled':''}>
              ${q.claimed ? '受取済み' : `🪙${q.reward} 受け取る`}
            </button>
          </div>
        </div>`;
    });
    modalContent.innerHTML = html;
    modalContent.querySelectorAll('.claim-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>claimQuest(btn.dataset.qid));
    });
  }

  // ===================== 記録・実績 =====================
  function buildAchievements(){
    return [
      { label:'はじめの一歩', done: (dailyStats.gamesPlayed||0)>=1, desc:'ゲームを1回プレイする' },
      { label:'ライン職人', done: (dailyStats.linesCleared||0)>=100, desc:'ラインを合計100本消す' },
      { label:'コンボマスター', done: (dailyStats.maxComboStreak||0)>=8, desc:'コンボを8連続つなげる' },
      { label:'トリプルクリア', done: (dailyStats.tripleClearCount||0)>=1, desc:'3ライン以上同時に消す' },
      { label:'硬派プレイヤー', done: (dailyStats.hardModeGamesPlayed||0)>=5, desc:'「硬い」以上の難易度を5回プレイ' },
      { label:'テトリスマスター', done: (tetrisBest||0)>=5000, desc:'テトリスモードで5000点以上を出す' },
      { label:'タイムアタック挑戦者', done: (bestScores.timeattack||0)>=1000, desc:'タイムアタックで1000点以上を出す' },
      { label:'クエストマニア', done: (questsCompletedCount||0)>=10, desc:'エンドレスクエストを10個クリアする' },
      { label:'コレクター', done: (ownedSkins||[]).length>=5, desc:'スキンを5個以上入手する' }
    ];
  }

  function renderRecordsModal(){
    modalContent.dataset.mode = 'records';
    const achievements = buildAchievements();
    const doneCount = achievements.filter(a=>a.done).length;
    let html = `
      <h2 style="color:var(--gold);">🏆 記録・実績</h2>
      <div class="sub" style="margin-bottom:10px;">これまでのプレイ記録と実績の達成状況です。</div>
      <div class="records-grid">
        <div class="record-box"><div class="rlabel">🏆 通常モード最高</div><div class="rval">${best}</div></div>
        <div class="record-box"><div class="rlabel">⏱ タイムアタック最高</div><div class="rval">${bestScores.timeattack||0}</div></div>
        <div class="record-box"><div class="rlabel">🧱 テトリス最高</div><div class="rval">${tetrisBest||0}</div></div>
        <div class="record-box"><div class="rlabel">🔥 最大コンボ</div><div class="rval">${dailyStats.maxComboStreak||0}</div></div>
        <div class="record-box"><div class="rlabel">💥 累計消去ライン</div><div class="rval">${dailyStats.linesCleared||0}</div></div>
        <div class="record-box"><div class="rlabel">🎮 総プレイ回数</div><div class="rval">${dailyStats.gamesPlayed||0}</div></div>
        <div class="record-box"><div class="rlabel">📊 総スコア</div><div class="rval">${dailyStats.scoreEarned||0}</div></div>
        <div class="record-box"><div class="rlabel">🧩 設置ピース数</div><div class="rval">${dailyStats.piecesPlaced||0}</div></div>
      </div>
      <h3 style="color:var(--mint); margin:14px 0 8px;">🎯 実績（${doneCount}/${achievements.length}）</h3>
      ${achievements.map(a=>`
        <div class="achievement-item ${a.done?'done':''}">
          <span class="ach-icon">${a.done?'✅':'🔒'}</span>
          <div><div class="ach-label">${a.label}</div><div class="ach-desc">${a.desc}</div></div>
        </div>`).join('')}
    `;
    modalContent.innerHTML = html;
  }

  // ===================== 設定(アプリ全体) =====================
  // ===================== 📮 ご要望・不具合報告(Discordへ転送) =====================
  let feedbackImageDataUrl = null;

  function renderFeedbackModal(tab){
    modalContent.dataset.mode = 'feedback';
    feedbackImageDataUrl = null;
    let html = `
      <h2 style="color:var(--gold);">📮 ご要望・不具合報告</h2>
      <div class="tab-row" style="margin-bottom:10px;">
        <button class="tab-btn ${tab==='request'?'active':''}" data-fbtab="request">💡 ご要望</button>
        <button class="tab-btn ${tab==='report'?'active':''}" data-fbtab="report">🐞 不具合報告</button>
      </div>
    `;
    if(tab === 'request'){
      html += `
        <div class="sub" style="margin-bottom:8px;">「こんな機能が欲しい」「こんなアップデートをしてほしい」など、次のアップデートに入れてほしい内容を考えて自由に書いてください。</div>
        <textarea id="feedbackText" placeholder="例: ○○モードに△△機能を追加してほしい、□□の見た目をもっとこうしてほしい、など" style="width:100%; min-height:140px; padding:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:var(--bg-deep2); color:var(--text); font-size:14px; font-family:'Nunito',sans-serif; resize:vertical; box-sizing:border-box;"></textarea>
        <button class="primary-btn" id="feedbackSendBtn">💡 要望を送信する</button>
        <div class="sub" id="feedbackStatus" style="margin-top:8px;"></div>
      `;
    } else {
      html += `
        <div class="sub" style="margin-bottom:4px; color:var(--coral); font-weight:700;">⚠️ 「スコアがランキングに反映されない」など再現の証拠が必要な不具合は、スクリーンショットが無いと対応できない場合があります。できるだけ画像を添付してください。</div>
        <textarea id="feedbackText" placeholder="例: ○○モードでスコアが加算されない、△△のボタンを押しても反応しない、など具体的に書いてください" style="width:100%; min-height:120px; padding:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:var(--bg-deep2); color:var(--text); font-size:14px; font-family:'Nunito',sans-serif; resize:vertical; box-sizing:border-box; margin-top:8px;"></textarea>
        <input type="file" id="feedbackImageInput" accept="image/*" style="display:none;">
        <button class="ghost-btn" id="feedbackImageBtn" style="width:100%; margin-top:8px;">🖼️ 画像を添付する(任意)</button>
        <div id="feedbackImagePreviewWrap" style="display:none; margin-top:8px;">
          <img id="feedbackImagePreview" style="max-width:100%; border-radius:12px; display:block;">
          <button class="ghost-btn" id="feedbackImageRemoveBtn" style="width:100%; margin-top:6px;">画像を削除</button>
        </div>
        <button class="primary-btn" id="feedbackSendBtn">🐞 報告を送信する</button>
        <div class="sub" id="feedbackStatus" style="margin-top:8px;"></div>
      `;
    }
    modalContent.innerHTML = html;

    modalContent.querySelectorAll('.tab-btn[data-fbtab]').forEach(btn=>{
      btn.addEventListener('click', ()=> renderFeedbackModal(btn.dataset.fbtab));
    });

    if(tab === 'report'){
      const imgBtn = document.getElementById('feedbackImageBtn');
      const imgInput = document.getElementById('feedbackImageInput');
      const previewWrap = document.getElementById('feedbackImagePreviewWrap');
      const previewImg = document.getElementById('feedbackImagePreview');
      imgBtn.addEventListener('click', ()=> imgInput.click());
      imgInput.addEventListener('change', (e)=>{
        const file = e.target.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          feedbackImageDataUrl = reader.result;
          previewImg.src = feedbackImageDataUrl;
          previewWrap.style.display = 'block';
        };
        reader.readAsDataURL(file);
      });
      document.getElementById('feedbackImageRemoveBtn').addEventListener('click', ()=>{
        feedbackImageDataUrl = null;
        imgInput.value = '';
        previewWrap.style.display = 'none';
      });
    }

    document.getElementById('feedbackSendBtn').addEventListener('click', async ()=>{
      const textEl = document.getElementById('feedbackText');
      const statusEl = document.getElementById('feedbackStatus');
      const message = textEl.value.trim();
      if(!message){ statusEl.textContent = '内容を入力してください。'; statusEl.style.color = 'var(--coral)'; return; }
      const sendBtn = document.getElementById('feedbackSendBtn');
      sendBtn.disabled = true;
      statusEl.textContent = '送信中...';
      statusEl.style.color = 'var(--text-dim)';
      try{
        const endpoint = tab === 'request' ? '/api/feedback/request' : '/api/feedback/report';
        const body = tab === 'request' ? { message } : { message, imageBase64: feedbackImageDataUrl };
        const headers = { 'Content-Type': 'application/json' };
        if(authToken) headers['Authorization'] = `Bearer ${authToken}`;
        const res = await fetch(`${API_BASE_URL}${endpoint}`, { method:'POST', headers, body: JSON.stringify(body) });
        const data = await res.json();
        if(!res.ok) throw new Error(data.error || '送信に失敗しました');
        statusEl.textContent = '✅ 送信しました。ありがとうございます！';
        statusEl.style.color = 'var(--mint)';
        textEl.value = '';
        feedbackImageDataUrl = null;
        const previewWrap = document.getElementById('feedbackImagePreviewWrap');
        if(previewWrap) previewWrap.style.display = 'none';
      }catch(err){
        statusEl.textContent = `送信に失敗しました: ${err.message}`;
        statusEl.style.color = 'var(--coral)';
      }finally{
        sendBtn.disabled = false;
      }
    });
  }

  function renderAppSettingsModal(){
    modalContent.dataset.mode = 'appsettings';
    modalContent.innerHTML = `
      <h2 style="color:var(--gold);">⚙ 設定</h2>
      <div class="settings-row">
        <span>🔊 音量</span>
        <input type="range" id="volumeSlider" min="0" max="100" value="${Math.round(soundVolume*100)}">
      </div>
      <div class="settings-row">
        <span>🌙 ダークモード</span>
        <label class="switch"><input type="checkbox" id="darkModeToggle" ${darkMode?'checked':''}><span class="switch-slider"></span></label>
      </div>
      <div class="settings-row" id="settingsAccountRow" style="cursor:pointer;">
        <span>👤 アカウント</span><span class="sub">${currentUserId ? currentUserId : 'ゲスト'} ›</span>
      </div>
      <div class="settings-row" id="settingsFeedbackRow" style="cursor:pointer;">
        <span>📮 ご要望・不具合報告</span><span class="sub">›</span>
      </div>
      <button class="ghost-btn danger" id="dataResetBtn" style="width:100%; margin-top:8px;">🗑 データリセット</button>
    `;
    document.getElementById('settingsFeedbackRow').addEventListener('click', ()=>{
      renderFeedbackModal('request');
    });
    document.getElementById('volumeSlider').addEventListener('input', (e)=>{
      soundVolume = parseInt(e.target.value,10)/100;
      saveAppSettings();
    });
    document.getElementById('volumeSlider').addEventListener('change', ()=> playSound('coin'));
    document.getElementById('darkModeToggle').addEventListener('change', (e)=>{
      darkMode = e.target.checked;
      applyDarkMode();
      saveAppSettings();
    });
    document.getElementById('settingsAccountRow').addEventListener('click', ()=>{
      closeModal();
      accountBtn.click();
    });
    document.getElementById('dataResetBtn').addEventListener('click', confirmDataReset);
  }

  function confirmDataReset(){
    const name = currentUserId || 'ゲスト';
    const typed = prompt(`⚠️「${name}」のデータを削除します。\nこの操作は取り消せません。よろしければ、確認のためアカウント名「${name}」を正確に入力してください。`);
    if(typed === null) return;
    if(typed !== name){ alert('入力内容が一致しなかったため、キャンセルしました。'); return; }
    performDataReset();
  }

  async function performDataReset(){
    bestScores = { soft:0, baked:0, hard:0, extreme:0, tetris:0, timeattack:0 };
    best = 0; tetrisBest = 0;
    dailyStats = { ...DAILY_STATS_DEFAULT };
    questsCompletedCount = 0; activeQuests = [];
    ensureActiveQuests();
    coins = 0;
    ownedSkins = ['default']; equippedSkin = 'default';
    saveBestScores(); saveDailyQuests(); saveCoins(0); saveSkinsData();
    applySkin('default');
    updateScoreUI(); updateCoinUI();
    if(authToken) await syncToServer();
    alert('データをリセットしました。');
    renderAppSettingsModal();
  }

  // ===================== スキン =====================
  function buildPatternedColors(baseColors, patternKey){
    if(!patternKey || !PATTERN_LAYERS[patternKey]) return baseColors;
    const layer = PATTERN_LAYERS[patternKey];
    return baseColors.map(c=>({ bg: `${layer}, ${c.bg}` }));
  }

  function applySkin(id){
    const skin = SKINS.find(s=>s.id===id) || SKINS[0];
    equippedSkin = skin.id;
    Object.entries(skin.vars).forEach(([k,v])=>document.documentElement.style.setProperty(k,v));
    const titleEl = document.querySelector('.title');
    if(titleEl) titleEl.style.background = skin.titleGrad;
    COLORS.length = 0;
    buildPatternedColors(skin.colors, skin.pattern).forEach(c=>COLORS.push(c));
    if(cellEls.length){
      board.forEach((cellData, idx)=>{
        if(cellData.filled && COLORS[cellData.colorIdx]) cellEls[idx].style.background = COLORS[cellData.colorIdx].bg;
      });
    }
    document.body.classList.toggle('gacha-shimmer-active', !!skin.gachaEffect);
    renderTray();
  }

  function buySkin(id){
    const skin = SKINS.find(s=>s.id===id);
    if(!skin || skin.gacha || ownedSkins.includes(id) || coins < skin.price) return;
    coins -= skin.price;
    ownedSkins.push(id);
    updateCoinUI();
    saveSkinsData();
    syncToServer();
    renderSettingsModal('skin');
  }

  function equipSkin(id){
    if(!ownedSkins.includes(id)) return;
    applySkin(id);
    saveSkinsData();
    syncToServer(); // ★これが無いとサーバー側のequippedSkinが更新されず、数秒後の定期同期で元のスキンに戻ってしまう
    renderSettingsModal('skin');
  }

  async function loadSkinsData(){
    try{
      const res = await appStorage.get(STORAGE_SKINS, false);
      if(res && res.value){
        const parsed = JSON.parse(res.value);
        ownedSkins = (parsed.owned && parsed.owned.length) ? parsed.owned : ['default'];
        equippedSkin = parsed.equipped || 'default';
      }
    }catch(err){ ownedSkins = ['default']; equippedSkin = 'default'; }
    applySkin(equippedSkin);
  }

  async function saveSkinsData(){
    try{ await appStorage.set(STORAGE_SKINS, JSON.stringify({owned:ownedSkins, equipped:equippedSkin}), false); }catch(err){}
  }

  // ===================== 設定 =====================
  async function loadSettings(){
    let isFirstTime = true;
    try{
      const res = await appStorage.get(STORAGE_SETTINGS, false);
      if(res && res.value){
        const parsed = JSON.parse(res.value);
        // タイムアタックはセッション的なモードなので、リロード時は自動再開せず通常モードに戻す
        currentMode = (MODES[parsed.mode] || parsed.mode==='tetris') ? parsed.mode : 'baked';
        SIZE = (currentMode==='extreme') ? 8 : Math.min(18, Math.max(5, parsed.size||8));
        isFirstTime = false;
      }
    }catch(err){}
    return isFirstTime;
  }
  async function saveSettings(){
    try{ await appStorage.set(STORAGE_SETTINGS, JSON.stringify({mode:currentMode, size:SIZE}), false); }catch(err){}
  }

  function renderModeTab(){
    let html = `<div class="sub" style="margin-bottom:10px;">モードと盤面サイズを選んで「この設定でスタート」を押してください。</div>`;
    Object.entries(MODES).forEach(([key, m])=>{
      const selected = pendingMode === key;
      html += `
        <div class="mode-card ${selected?'selected':''}" data-mode="${key}">
          <div class="mode-card-head"><span class="mode-emoji">${m.emoji}</span><span>${m.label}</span>
            <span class="coin-tag">🪙×${MODE_COIN_MULT[key]}</span></div>
        </div>`;
    });
    const tetrisSelected = pendingMode === 'tetris';
    html += `
      <div class="mode-card ${tetrisSelected?'selected':''}" data-mode="tetris">
        <div class="mode-card-head"><span class="mode-emoji">🧱</span><span>テトリス</span>
          <span class="coin-tag">NEW</span></div>
      </div>`;
    const taSelected = pendingMode === 'timeattack';
    html += `
      <div class="mode-card ${taSelected?'selected':''}" data-mode="timeattack">
        <div class="mode-card-head"><span class="mode-emoji">⏱</span><span>タイムアタック</span>
          <span class="coin-tag">NEW</span></div>
      </div>`;

    if(pendingMode === 'tetris'){
      html += `
        <div class="sub" style="margin:8px 0;">テトリス。タッチ操作を完全修正。ズームすることがなくなりました。</div>
        <button class="primary-btn" id="applyModeBtn">テトリスを始める</button>`;
      return html;
    }
    if(pendingMode === 'timeattack'){
      html += `
        <div class="sub" style="margin:8px 0;">制限時間${TIME_ATTACK_DURATION}秒でどれだけ高得点を出せるか挑戦！してね。うん。</div>
        <button class="primary-btn" id="applyModeBtn">タイムアタックを始める</button>`;
      return html;
    }

    const sizeNow = pendingMode==='extreme' ? 8 : pendingSize;
    const totalMult = (MODE_COIN_MULT[pendingMode] * sizeCoinMult(sizeNow)).toFixed(2);
    html += `
      <div class="size-row">
        <div class="qtitle" style="margin-bottom:2px;">盤面サイズ: <span id="sizeVal">${sizeNow}</span> × ${sizeNow}</div>
        <input type="range" id="sizeSlider" min="5" max="18" step="1" value="${sizeNow}" ${pendingMode==='extreme'?'disabled':''}>
        <div class="sub" style="margin-top:4px;">${pendingMode==='extreme' ? '激硬モードは8×8で固定です。' : '盤面が小さいほどコイン倍率が上がります。'}</div>
        <div class="sub" style="margin-top:8px; color:var(--gold); font-weight:800;">獲得コイン倍率: ×<span id="totalMultVal">${totalMult}</span>(焼成8×8が基準の×1.00)</div>
      </div>
      <button class="primary-btn" id="applyModeBtn">この設定でスタート</button>`;
    return html;
  }

  let skinFilter = 'all';
  function renderSkinTab(){
    let html = `<div class="sub" style="margin-bottom:8px;">🪙 ${formatNumber(coins)} 所持中。ゲームで貯めたコインで見た目を変えられます。</div>`;
    html += `<div class="tab-row" style="margin-bottom:10px; flex-wrap:wrap;">
      <button class="tab-btn sfilter-btn ${skinFilter==='all'?'active':''}" data-sfilter="all">すべて</button>
      <button class="tab-btn sfilter-btn ${skinFilter==='plain'?'active':''}" data-sfilter="plain">無地</button>
      <button class="tab-btn sfilter-btn ${skinFilter==='pattern'?'active':''}" data-sfilter="pattern">🎨 柄物</button>
      <button class="tab-btn sfilter-btn ${skinFilter==='gacha'?'active':''}" data-sfilter="gacha">🎰 ガチャ限定</button>
    </div>`;
    // ガチャ限定スキンは通常ショップの「すべて/無地/柄物」には出さず、専用フィルタでのみ表示する(コインでの購入は不可)
    const list = SKINS.filter(s => {
      if(skinFilter==='gacha') return !!s.gacha;
      if(s.gacha) return false;
      return skinFilter==='all' ? true : skinFilter==='pattern' ? !!s.pattern : !s.pattern;
    }).slice().sort((a,b)=>a.price-b.price); // 値段の安い順に並べる
    if(skinFilter==='gacha' && list.every(s=>!ownedSkins.includes(s.id))){
      html += `<div class="empty-hint">まだガチャ限定スキンを持っていません。🎰ガチャで手に入れよう！</div>`;
    }
    list.forEach(skin=>{
      const owned = ownedSkins.includes(skin.id);
      const equipped = equippedSkin === skin.id;
      const canBuy = !owned && !skin.gacha && coins >= skin.price;
      let btnLabel = equipped ? '装備中' : owned ? '装備する' : (skin.gacha ? '🎰ガチャ限定' : (skin.price===0 ? '入手する' : (canBuy ? '購入する' : 'コインが足りません')));
      let btnAction = equipped ? '' : owned ? 'equip' : (skin.gacha ? '' : 'buy');
      const swatchColors = buildPatternedColors(skin.colors, skin.pattern);
      if(skin.gacha && !owned) return; // 未入手のガチャ限定スキンはカードごと非表示(ガチャフィルタでは「持っていない」ことが分かればよい)
      html += `
        <div class="quest-item">
          <div class="qtitle">${skin.name}${equipped?' ✅':''}${skin.pattern?' <span class="coin-tag">柄物</span>':''}${skin.gacha?' <span class="coin-tag">🎰限定</span>':''}</div>
          <div class="sub" style="margin:2px 0 8px;">${skin.desc}</div>
          <div class="skin-swatches">${swatchColors.map(c=>`<span class="swatch" style="background:${c.bg}"></span>`).join('')}</div>
          <div class="quest-foot" style="margin-top:8px;">
            <span>${skin.gacha ? '🎰ガチャ限定' : (skin.price===0 ? '無料' : `🪙${formatNumber(skin.price)}`)}</span>
            <button class="claim-btn" data-skin="${skin.id}" data-action="${btnAction}" ${(equipped || (!owned && (!canBuy && !skin.gacha)) || (skin.gacha && !owned))?'disabled':''}>${btnLabel}</button>
          </div>
        </div>`;
    });
    return html;
  }

  function renderSettingsModal(tab){
    modalContent.dataset.mode = 'settings';
    modalContent.innerHTML = `
      <h2 style="color:var(--gold);">⚙️ 設定</h2>
      <div class="tab-row">
        <button class="tab-btn ${tab==='mode'?'active':''}" data-stab="mode">ゲームモード</button>
        <button class="tab-btn ${tab==='skin'?'active':''}" data-stab="skin">🎨 スキン</button>
        <button class="tab-btn ${tab==='bg'?'active':''}" data-stab="bg">🖼️ 背景</button>
      </div>
      <div id="settingsTabBody">${tab==='skin' ? renderSkinTab() : tab==='bg' ? renderBgTab() : renderModeTab()}</div>
    `;
    modalContent.querySelectorAll('.tab-btn[data-stab]').forEach(btn=>{
      btn.addEventListener('click', ()=>renderSettingsModal(btn.dataset.stab));
    });
    if(tab==='skin'){
      modalContent.querySelectorAll('.sfilter-btn').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          skinFilter = btn.dataset.sfilter;
          renderSettingsModal('skin');
        });
      });
      modalContent.querySelectorAll('.claim-btn[data-skin]').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const id = btn.dataset.skin, action = btn.dataset.action;
          if(action==='buy') buySkin(id);
          else if(action==='equip') equipSkin(id);
        });
      });
    } else if(tab==='bg'){
      const fileInput = document.getElementById('bgFileInput');
      const pickBtn = document.getElementById('bgPickBtn');
      const resetBtn = document.getElementById('bgResetBtn');
      if(pickBtn) pickBtn.addEventListener('click', ()=> fileInput.click());
      if(fileInput) fileInput.addEventListener('change', async (e)=>{
        const file = e.target.files[0];
        if(!file) return;
        const statusEl = document.getElementById('bgStatus');
        if(statusEl) statusEl.textContent = '画像を処理中...';
        try{
          await setCustomBackgroundFromFile(file);
          renderSettingsModal('bg');
        }catch(err){
          if(statusEl) statusEl.textContent = '画像の読み込みに失敗しました。別の画像でお試しください。';
        }
      });
      if(resetBtn) resetBtn.addEventListener('click', async ()=>{
        await resetCustomBackground();
        renderSettingsModal('bg');
      });
    } else {
      modalContent.querySelectorAll('.mode-card').forEach(card=>{
        card.addEventListener('click', ()=>{
          pendingMode = card.dataset.mode;
          if(pendingMode==='extreme') pendingSize = 8;
          renderSettingsModal('mode');
        });
      });
      const slider = document.getElementById('sizeSlider');
      if(slider){
        slider.addEventListener('input', (e)=>{
          pendingSize = parseInt(e.target.value,10);
          const label = document.getElementById('sizeVal');
          if(label) label.textContent = pendingSize;
          const multLabel = document.getElementById('totalMultVal');
          if(multLabel) multLabel.textContent = (MODE_COIN_MULT[pendingMode] * sizeCoinMult(pendingSize)).toFixed(2);
        });
      }
      const applyBtn = document.getElementById('applyModeBtn');
      if(applyBtn) applyBtn.addEventListener('click', ()=>{ applyMode(pendingMode, pendingSize); closeModal(); });
    }
  }

  settingsBtn.addEventListener('click', ()=>{
    pendingMode = currentMode; pendingSize = SIZE;
    renderSettingsModal('mode');
    modalOverlay.classList.add('show');
  });

  // ===================== サウンド =====================
  let audioCtx = null;
  function unlockAudio(){
    try{
      if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      if(audioCtx.state === 'suspended') audioCtx.resume();
    }catch(err){}
  }
  // より満足感のあるサウンド(単純な音量アップではなく、和音・アルペジオで表現)
  function playSound(type, intensity){
    if(!soundOn || soundVolume<=0) return;
    try{
      unlockAudio();
      if(!audioCtx) return;
      const t0 = audioCtx.currentTime;
      const master = audioCtx.createGain();
      master.gain.value = soundVolume;
      master.connect(audioCtx.destination);
      if(type==='place'){
        const o1 = audioCtx.createOscillator(), g1 = audioCtx.createGain();
        o1.type='sine'; o1.frequency.setValueAtTime(520, t0); o1.frequency.exponentialRampToValueAtTime(300, t0+0.08);
        g1.gain.setValueAtTime(0.10, t0); g1.gain.exponentialRampToValueAtTime(0.001, t0+0.09);
        o1.connect(g1); g1.connect(master); o1.start(t0); o1.stop(t0+0.1);
        const o2 = audioCtx.createOscillator(), g2 = audioCtx.createGain();
        o2.type='triangle'; o2.frequency.setValueAtTime(780, t0);
        g2.gain.setValueAtTime(0.045, t0); g2.gain.exponentialRampToValueAtTime(0.001, t0+0.05);
        o2.connect(g2); g2.connect(master); o2.start(t0); o2.stop(t0+0.06);
      } else if(type==='clear'){
        const lvl = intensity||1;
        const notes = lvl>=4 ? [523.25,659.25,783.99,1046.5] : lvl>=2 ? [523.25,659.25,783.99] : [523.25,659.25];
        notes.forEach((freq,i)=>{
          const start = t0 + i*0.055;
          const o = audioCtx.createOscillator(), g = audioCtx.createGain();
          o.type='triangle'; o.frequency.setValueAtTime(freq, start);
          g.gain.setValueAtTime(0.001, start);
          g.gain.linearRampToValueAtTime(0.13, start+0.015);
          g.gain.exponentialRampToValueAtTime(0.001, start+0.22);
          o.connect(g); g.connect(master);
          o.start(start); o.stop(start+0.23);
        });
      } else if(type==='coin'){
        [1046.5, 1568].forEach((freq,i)=>{
          const start = t0 + i*0.045;
          const o = audioCtx.createOscillator(), g = audioCtx.createGain();
          o.type='sine'; o.frequency.setValueAtTime(freq, start);
          g.gain.setValueAtTime(0.001, start);
          g.gain.linearRampToValueAtTime(0.12, start+0.01);
          g.gain.exponentialRampToValueAtTime(0.001, start+0.18);
          o.connect(g); g.connect(master);
          o.start(start); o.stop(start+0.19);
        });
      } else if(type==='gameover'){
        [392,329.63,261.63].forEach((freq,i)=>{
          const start = t0 + i*0.12;
          const o = audioCtx.createOscillator(), g = audioCtx.createGain();
          o.type='sine'; o.frequency.setValueAtTime(freq, start);
          g.gain.setValueAtTime(0.11, start);
          g.gain.exponentialRampToValueAtTime(0.001, start+0.35);
          o.connect(g); g.connect(master);
          o.start(start); o.stop(start+0.36);
        });
      } else if(type==='timer'){
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type='square'; o.frequency.setValueAtTime(880, t0);
        g.gain.setValueAtTime(0.06, t0); g.gain.exponentialRampToValueAtTime(0.001, t0+0.08);
        o.connect(g); g.connect(master); o.start(t0); o.stop(t0+0.09);
      }
    }catch(err){}
  }
  soundBtn.addEventListener('click', ()=>{
    unlockAudio();
    soundOn = !soundOn;
    soundBtn.textContent = soundOn ? '🔊' : '🔇';
  });
  document.body.addEventListener('pointerdown', unlockAudio, { once:true });

  // ===================== ゲームオーバー =====================
  function endGame(){
    playSound('gameover');
    stopTimeAttackTimer();
    dailyStats.gamesPlayed += 1;
    if(currentMode==='hard' || currentMode==='extreme') dailyStats.hardModeGamesPlayed = (dailyStats.hardModeGamesPlayed||0) + 1;
    saveDailyQuests();
    updateQuestProgress();
    grantBattlePassXp(sessionScoreForXp);
    sessionScoreForXp = 0;

    if(weeklyChallengeActive){
      weeklyChallengeActive = false;
      finalScoreEl.textContent = score;
      newBestNoteEl.textContent = '🎲 週替わりチャレンジ結果';
      coinEarnedNoteEl.textContent = '';
      duelResultNoteEl.textContent = '送信中...';
      overlayEl.classList.add('show');
      submitWeeklyChallengeScore(score);
      syncPlayTime();
      return;
    }

    const earned = awardGameEndCoins();
    if(earned>0) playSound('coin');
    finalScoreEl.textContent = score;
    const refBest = isRegularMode(currentMode) ? best : (bestScores[currentMode]||0);
    newBestNoteEl.textContent = (score>=refBest && score>0) ? '🎉 ハイスコア更新！' : 'お疲れさまでした！';
    coinEarnedNoteEl.textContent = earned>0 ? `🪙 +${earned} コイン獲得！` : '';
    duelResultNoteEl.textContent = '';
    if(currentDuelId){
      const duelId = currentDuelId;
      currentDuelId = null;
      duelResultNoteEl.textContent = '対決の結果を送信中...';
      submitDuelScore(duelId, score).then(duel=>{
        if(duel){
          duelResultNoteEl.textContent = duelResultText(duel);
          if(duel.status==='completed') syncFromServer(); // 対決報酬のコインをすぐ画面に反映
        }
        else duelResultNoteEl.textContent = '対決結果の送信に失敗しました。';
      });
    }
    overlayEl.classList.add('show');
    // ゲーム終了時にサーバーへ送信（既にリアルタイムで送っているが、念のため）
    if (authToken) syncToServer();
    syncPlayTime();
  }

  async function submitWeeklyChallengeScore(finalScore){
    try{
      const res = await fetch(`${API_BASE_URL}/api/weekly-challenge/submit`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` },
        body: JSON.stringify({ score: finalScore })
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || '送信に失敗しました');
      duelResultNoteEl.textContent = `✅ スコア${finalScore}を送信しました！結果はランキングで確認できます。`;
    }catch(err){
      duelResultNoteEl.textContent = `送信に失敗しました: ${err.message}`;
    }
  }
  restartBtn.addEventListener('click', ()=>{
    overlayEl.classList.remove('show');
    if(currentMode==='tetris'){ restartTetris(); return; }
    score = 0; streak = 0; noClearStreak = 0;
    updateScoreUI();
    initBoard();
    fillTray();
  });

  // ===================== モーダル共通 =====================
  function closeModal(){
    modalOverlay.classList.remove('show');
    modalContent.dataset.mode = '';
    if (chatPollingInterval) {
      clearInterval(chatPollingInterval);
      chatPollingInterval = null;
    }
    if (rankingPollInterval) {
      clearInterval(rankingPollInterval);
      rankingPollInterval = null;
    }
  }
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e)=>{ if(e.target===modalOverlay) closeModal(); });

  questBtn.addEventListener('click', ()=>{
    renderQuestModal();
    modalOverlay.classList.add('show');
  });

  // ===================== アカウント（修正：ログアウト時に完全リセット） =====================
  function resetToGuest() {
    // ゲスト状態にリセット
    authToken = null;
    currentUserId = null;
    clearAuthSession();
    // データ初期化
    bestScores = { soft:0, baked:0, hard:0, extreme:0 };
    best = 0;
    coins = 0;
    ownedSkins = ['default'];
    equippedSkin = 'default';
    // クエストもリセット(統計を初期化し、新規クエストをやり直す)
    dailyStats = { ...DAILY_STATS_DEFAULT };
    questsCompletedCount = 0;
    activeQuests = [];
    ensureActiveQuests();
    // プレイ時間リセット
    stopPlayTimeTracking();
    // リアルタイム同期も停止
    stopUserSync();
    playTime = 0;
    // UI更新
    bestValEl.textContent = '0';
    coinValEl.textContent = '0';
    score = 0; streak = 0; noClearStreak = 0;
    updateScoreUI();
    // スキン適用
    applySkin('default');
    // 盤面を新しくする
    initBoard();
    fillTray();
    // 保存（ゲスト用）
    saveBestScores();
    saveCoins(0);
    saveSkinsData();
    saveDailyQuests();
    // アカウントボタン更新
    updateAccountButton();
    // 管理者パネル非表示
    adminPanelBtn.style.display = 'none';
    // ランキングポーリング停止
    if (rankingPollInterval) {
      clearInterval(rankingPollInterval);
      rankingPollInterval = null;
    }
    // フレンド／チャット未読バッジのポーリング停止＆バッジ非表示
    stopBackgroundPolling();
    friendsList = []; incomingRequests = []; outgoingRequests = [];
    dmUnreadTotal = 0; dmMentionCount = 0; dmPerFriendUnread = {};
    chatUnreadCount = 0; chatMentionCount = 0; chatLastSeenId = 0;
    updateFriendsBadge();
    updateChatBadge();
  }

  function updateAccountButton(){
    accountBtn.textContent = currentUserId ? '👤' : '👤';
    accountBtn.title = currentUserId ? `ログイン中: ${currentUserId}` : '未ログイン';
    if (currentUserId === 'admin') {
      adminPanelBtn.style.display = 'flex';
      loadAdminSettings();
    } else {
      adminPanelBtn.style.display = 'none';
    }
    if (currentUserId) {
      startBackgroundPolling();
    } else {
      stopBackgroundPolling();
    }
  }

  async function deleteAccount() {
    if (!authToken) return;
    if (!confirm('⚠️ 本当にアカウントを削除しますか？\nこの操作は元に戻せません！')) return;
    if (!confirm('本当に削除しますか？（最終確認）')) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/account/delete`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (!res.ok) throw new Error('削除に失敗しました');
      alert('アカウントを削除しました。');
      resetToGuest();
      renderAuthModal();
    } catch(err) {
      alert(err.message);
    }
  }

  function renderAuthModal(){
    modalContent.dataset.mode = 'auth';
    if(currentUserId){
      modalContent.innerHTML = `
        <h2 style="color:var(--gold);">👤 アカウント</h2>
        <div class="sub">ログイン中: <b>${currentUserId}</b></div>
        <div class="sub">スコア・コインはサーバーと同期されています。</div>
        <button class="primary-btn" id="syncNowBtn">今すぐ同期する</button>
        <button class="ghost-btn" id="logoutBtn">ログアウト</button>
        <button class="ghost-btn" id="deleteAccountBtn" style="color:var(--coral);border-color:var(--coral);">🗑️ アカウント削除</button>
      `;
      document.getElementById('logoutBtn').addEventListener('click', ()=>{
        resetToGuest();  // 完全リセット
        closeModal();
      });
      document.getElementById('syncNowBtn').addEventListener('click', async ()=>{
        await syncToServer();
        await syncFromServer();
      });
      document.getElementById('deleteAccountBtn').addEventListener('click', deleteAccount);
      return;
    }
    modalContent.innerHTML = `
      <h2 style="color:var(--gold);">👤 アカウント</h2>
      <div class="tab-row">
        <button class="tab-btn active" data-tab="login">ログイン</button>
        <button class="tab-btn" data-tab="register">新規登録</button>
        <button class="tab-btn" data-tab="recover">復元</button>
      </div>
      <form class="auth-form active" id="loginForm">
        <label>ID</label><input type="text" id="loginId" autocomplete="username" />
        <label>パスワード</label><input type="password" id="loginPw" autocomplete="current-password" />
        <button type="submit" class="primary-btn">ログイン</button>
        <div class="auth-msg" id="loginMsg"></div>
      </form>
      <form class="auth-form" id="registerForm">
        <label>ID (半角英数字3〜20文字)</label><input type="text" id="regId" autocomplete="username" />
        <label>パスワード (6文字以上)</label><input type="password" id="regPw" autocomplete="new-password" />
        <button type="submit" class="primary-btn">新規登録</button>
        <div class="auth-msg" id="regMsg"></div>
      </form>
      <form class="auth-form" id="recoverForm">
        <label>ID</label><input type="text" id="recId" />
        <label>復元コード(管理者から受け取ったもの)</label><input type="text" id="recCode" placeholder="XXXX-XXXX-XXXX-XXXX" />
        <label>新しいパスワード</label><input type="password" id="recPw" autocomplete="new-password" />
        <button type="submit" class="primary-btn">パスワードを再設定</button>
        <div class="auth-msg" id="recMsg"></div>
      </form>
    `;
    modalContent.querySelectorAll('.tab-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        modalContent.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
        modalContent.querySelectorAll('.auth-form').forEach(f=>f.classList.remove('active'));
        btn.classList.add('active');
        modalContent.querySelector(`#${btn.dataset.tab}Form`).classList.add('active');
      });
    });
    document.getElementById('loginForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const id = document.getElementById('loginId').value.trim();
      const password = document.getElementById('loginPw').value;
      const msgEl = document.getElementById('loginMsg');
      msgEl.textContent = '処理中...'; msgEl.className='auth-msg';
      try{
        const r = await fetch(`${API_BASE_URL}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id,password}) });
        const data = await r.json();
        if(!r.ok) throw new Error(data.error || 'ログインに失敗しました。');
        authToken = data.token;
        currentUserId = data.id;
        await saveAuthSession(authToken, currentUserId);
        // ログイン後、サーバーからデータ取得
        await syncFromServer();
        // ローカルに反映（syncFromServerでbestScores, coins, skinsなどが更新される）
        updateAccountButton();
        // プレイ時間追跡開始
        startPlayTimeTracking();
        // ログイン中はサーバーの変更をリアルタイムで反映
        startUserSync();
        msgEl.textContent = 'ログインしました！'; msgEl.className='auth-msg ok';
        // UI更新
        updateScoreUI();
        updateCoinUI();
        applySkin(equippedSkin);
        // モーダル閉じる
        setTimeout(()=>{ closeModal(); }, 500);
      }catch(err){
        msgEl.textContent = err.message + '(サーバーに接続できているか確認してください)';
        msgEl.className='auth-msg error';
      }
    });
    document.getElementById('registerForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const id = document.getElementById('regId').value.trim();
      const password = document.getElementById('regPw').value;
      const msgEl = document.getElementById('regMsg');
      msgEl.textContent = '処理中...'; msgEl.className='auth-msg';
      try{
        const r = await fetch(`${API_BASE_URL}/api/register`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id,password}) });
        const data = await r.json();
        if(!r.ok) throw new Error(data.error || '登録に失敗しました。');
        authToken = data.token; currentUserId = data.id;
        await saveAuthSession(authToken, currentUserId);
        // 新規登録時はデフォルトデータ
        bestScores = { soft:0, baked:0, hard:0, extreme:0 };
        coins = 0;
        ownedSkins = ['default'];
        equippedSkin = 'default';
        playTime = 0;
        saveBestScores();
        saveCoins(0);
        saveSkinsData();
        // クエストは新しく生成
        // クエストは新しく生成
        dailyStats = { ...DAILY_STATS_DEFAULT };
        questsCompletedCount = 0;
        activeQuests = [];
        ensureActiveQuests();
        saveDailyQuests();
        updateScoreUI();
        updateCoinUI();
        applySkin('default');
        startPlayTimeTracking();
        startUserSync();
        updateAccountButton();
        msgEl.textContent = '登録が完了しました！復元コードは管理者のDiscordに通知されました。';
        msgEl.className='auth-msg ok';
        await syncToServer();
        setTimeout(()=>{ closeModal(); }, 800);
      }catch(err){
        msgEl.textContent = err.message;
        msgEl.className='auth-msg error';
      }
    });
    document.getElementById('recoverForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const id = document.getElementById('recId').value.trim();
      const recoveryCode = document.getElementById('recCode').value.trim();
      const newPassword = document.getElementById('recPw').value;
      const msgEl = document.getElementById('recMsg');
      msgEl.textContent = '処理中...'; msgEl.className='auth-msg';
      try{
        const r = await fetch(`${API_BASE_URL}/api/recover`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id,recoveryCode,newPassword}) });
        const data = await r.json();
        if(!r.ok) throw new Error(data.error || '復元に失敗しました。');
        msgEl.textContent = 'パスワードを再設定しました。ログインしてください。';
        msgEl.className='auth-msg ok';
      }catch(err){
        msgEl.textContent = err.message;
        msgEl.className='auth-msg error';
      }
    });
  }

  accountBtn.addEventListener('click', ()=>{ renderAuthModal(); modalOverlay.classList.add('show'); });

  // ===================== サーバー同期（修正：ベストスコアをモード別に送信） =====================
  async function syncToServer(){
    if(!authToken) return;
    try{
      const r = await fetch(`${API_BASE_URL}/api/sync`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` },
        body: JSON.stringify({
          bestScore: bestScores[currentMode] || 0,  // 現在のモードのベストを送信
          coins,
          skins: ownedSkins,
          equippedSkin,
          quests: activeQuests,
          mode: currentMode,
          size: SIZE,
          playTime
        })
      });
      if(r.ok){
        const data = await r.json();
        // サーバー側の確定値でローカルを上書きする(管理者コマンド等で
        // サーバー側の値が変わっていた場合に、古いローカル表示のまま
        // ズレ続けてしまうのを防ぐ)
        if(data.bestScores && typeof data.bestScores === 'object'){
          bestScores = { ...bestScores, ...data.bestScores };
          tetrisBest = bestScores.tetris || 0;
          saveBestScores();
          if(isRegularMode(currentMode)){
            best = Math.max(bestScores.soft, bestScores.baked, bestScores.hard, bestScores.extreme);
          }
        }
        if(data.coins !== undefined){
          coins = data.coins;
          updateCoinUI();
        }
      }
    }catch(err){ console.warn('サーバー同期に失敗しました:', err.message); }
  }

  async function syncFromServer(){
    if(!authToken) return;
    try{
      const r = await fetch(`${API_BASE_URL}/api/sync`, { headers:{ 'Authorization':`Bearer ${authToken}` } });
      if(!r.ok) return;
      const data = await r.json();
      applySyncData(data);
    }catch(err){ console.warn('サーバーからの取得に失敗しました:', err.message); }
  }

  function applySyncData(data){
    // ベストスコア（モード別がある場合はそちらを優先）
    if (data.bestScores && typeof data.bestScores === 'object') {
      bestScores = { ...bestScores, ...data.bestScores };
    } else if (data.bestScore !== undefined) {
      // 互換性: 全体ベストのみの場合、現在のモードに設定（他のモードはそのまま）
      bestScores[currentMode] = Math.max(bestScores[currentMode] || 0, data.bestScore);
    }
    tetrisBest = bestScores.tetris || 0;
    if (currentMode === 'tetris') {
      bestValEl.textContent = tetrisBest;
    } else {
      best = Math.max(bestScores.soft, bestScores.baked, bestScores.hard, bestScores.extreme);
      bestValEl.textContent = best;
    }
    saveBestScores();

    if (data.coins !== undefined) {
      coins = data.coins;
      coinValEl.textContent = formatNumber(coins);
      saveCoins(coins);
    }
    if (data.skins) {
      ownedSkins = data.skins;
      saveSkinsData();
    }
    if (data.equippedSkin) {
      equippedSkin = data.equippedSkin;
      applySkin(equippedSkin);
      saveSkinsData();
    }
    if (data.playTime !== undefined) {
      playTime = data.playTime;
    }
    // クエストはサーバーにあれば反映（他端末での進捗を引き継ぐ）
    if (data.quests && data.quests.length && data.quests[0].poolId) {
      activeQuests = data.quests;
      ensureActiveQuests();
      saveDailyQuests();
    }
  }

  // ===================== 管理者設定 =====================
  async function loadAdminSettings() {
    if (!authToken || currentUserId !== 'admin') return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/block-settings`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        adminDisabledBlocks = data.disabledBlocks || [];
        adminSafetyMode = data.safetyMode || false;
      }
    } catch(e) {}
  }

  async function executeAdminCommand(cmd) {
    if (!authToken || currentUserId !== 'admin') return '❌ 管理者権限がありません';
    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/command`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` },
        body: JSON.stringify({ command: cmd })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'コマンド実行に失敗しました');
      if (cmd.startsWith('/setcoins')) {
        // /setcoins <ユーザーID> <amount> — 自分自身が対象の場合のみローカル表示を更新
        const parts = cmd.trim().split(/\s+/);
        const targetId = parts[1];
        const newCoins = parseInt(parts[2]);
        if (targetId === currentUserId && !isNaN(newCoins) && newCoins >= 0) {
          coins = newCoins; updateCoinUI(); saveCoins(coins); syncToServer();
        }
      }
      if (cmd.startsWith('/addcoins')) {
        // /addcoins <ユーザーID> <amount> — 自分自身が対象の場合のみローカル表示を更新
        const parts = cmd.trim().split(/\s+/);
        const targetId = parts[1];
        const addAmount = parseInt(parts[2]);
        if (targetId === currentUserId && !isNaN(addAmount)) {
          coins = Math.max(0, coins + addAmount); updateCoinUI(); saveCoins(coins); syncToServer();
        }
      }
      if (cmd.startsWith('/setscore')) {
        // /setscore <ユーザーID> <mode> <score> — 自分自身が対象の場合のみローカル表示を更新
        const parts = cmd.trim().split(/\s+/);
        const targetId = parts[1];
        const mode = parts[2];
        const scoreVal = parseInt(parts[3]);
        if (targetId === currentUserId && RANKING_MODES.includes(mode) && !isNaN(scoreVal) && scoreVal >= 0) {
          bestScores[mode] = scoreVal;
          if (mode === 'tetris') tetrisBest = scoreVal;
          if (isRegularMode(mode)) {
            best = Math.max(bestScores.soft, bestScores.baked, bestScores.hard, bestScores.extreme);
            bestValEl.textContent = best;
          } else if (currentMode === mode) {
            animateNumberTo(bestValEl, scoreVal);
          }
          saveBestScores();
          syncToServer();
        }
      }
      return data.result || '✅ コマンドを実行しました';
    } catch(e) {
      return '❌ ' + e.message;
    }
  }

  async function renderAdminPanel() {
    modalContent.dataset.mode = 'admin';
    let html = `
      <h2 style="color:var(--gold);">🔧 管理者パネル</h2>
      <div class="sub">admin専用コマンド実行欄です。</div>
      <div class="admin-setting-item">
        <div class="label-row"><span>⌨️ 管理者コマンド</span></div>
        <input type="text" id="adminCmdInput" placeholder="コマンドを入力..." style="width:100%;padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:var(--bg-deep2);color:var(--text);font-size:14px;font-family:'Nunito',sans-serif;margin-bottom:6px;">
        <button class="primary-btn" id="adminCmdBtn">実行</button>
        <div class="cmd-output" id="adminCmdOutput">📋 コマンド一覧:
  /setcoins &lt;ユーザーID&gt; &lt;amount&gt; - 指定ユーザーのコインを設定
  /addcoins &lt;ユーザーID&gt; &lt;amount&gt; - 指定ユーザーのコインに加算（元のコイン+amount）
  /setscore &lt;ユーザーID&gt; &lt;mode&gt; &lt;score&gt; - 指定ユーザーのモード別スコア設定 (soft, baked, hard, extreme, tetris, timeattack)
  /safety [on|off] - 強制セーフティモード（引数なしで状態表示）
  /announce &lt;メッセージ&gt; - 全ユーザーにお知らせを配信
  /eventadd &lt;once|daily|weekly|monthly&gt; &lt;mode&gt; &lt;順位&gt; &lt;コイン&gt; &lt;年&gt; &lt;月&gt; &lt;日&gt; &lt;時&gt; &lt;分&gt; - ランキング順位者へコインを自動配布するイベントを追加(JST基準)
  /eventlist - 登録済みイベント一覧を表示
  /eventremove &lt;ID&gt; - イベントを削除
  /resetquests - 全ユーザーのクエスト進捗リセット
  /setplaytime &lt;seconds&gt; - プレイ時間を設定
  /ban &lt;ID&gt; - ユーザーをBAN
  /unban &lt;ID&gt; - BAN解除
  /resetuser &lt;ID&gt; - ユーザーデータリセット
  /listusers - ユーザー一覧表示
  /search &lt;ID&gt; - ユーザー情報検索
  /stats - サーバー統計情報
  /help - このヘルプ</div>
      </div>
      <div class="admin-setting-item">
        <div class="label-row"><span>🧩 ブロック出現設定（オフにすると出現しなくなります）</span></div>
        <div style="max-height:200px; overflow-y:auto;">
    `;
    SHAPES.forEach((shape, idx) => {
      const isOff = adminDisabledBlocks.includes(idx);
      const {rows, cols} = shapeBounds(shape);
      const size = 24;
      html += `
        <div style="display:flex; align-items:center; gap:10px; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
          <div class="block-grid-preview" style="grid-template-columns:repeat(${cols}, ${size}px); grid-template-rows:repeat(${rows}, ${size}px);">
            ${Array.from({length: rows*cols}, (_, i) => {
              const r = Math.floor(i/cols), c = i%cols;
              const filled = shape.some(([sr,sc])=>sr===r&&sc===c);
              return `<div class="block-cell ${filled?'':'empty'}"></div>`;
            }).join('')}
          </div>
          <span style="font-size:12px; color:var(--text-dim);">#${idx}</span>
          <div style="margin-left:auto; display:flex; align-items:center; gap:8px;">
            <span style="font-size:12px; color:${isOff ? 'var(--coral)' : 'var(--mint)'};">${isOff ? 'OFF' : 'ON'}</span>
            <div class="toggle-switch ${isOff ? '' : 'active'}" data-block-index="${idx}" style="cursor:pointer;">
              <div class="knob"></div>
            </div>
          </div>
        </div>
      `;
    });
    html += `</div></div>`;
    modalContent.innerHTML = html;

    document.getElementById('adminCmdBtn').addEventListener('click', async () => {
      const input = document.getElementById('adminCmdInput');
      const output = document.getElementById('adminCmdOutput');
      const cmd = input.value.trim();
      if (!cmd) return;
      output.textContent = '⏳ 実行中...';
      const result = await executeAdminCommand(cmd);
      output.innerHTML = result;
      input.value = '';
    });

    document.querySelectorAll('.toggle-switch[data-block-index]').forEach(el => {
      el.addEventListener('click', async function() {
        const idx = parseInt(this.dataset.blockIndex, 10);
        const currentOff = adminDisabledBlocks.includes(idx);
        const enabled = currentOff;
        try {
          const res = await fetch(`${API_BASE_URL}/api/admin/block-toggle`, {
            method: 'POST',
            headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` },
            body: JSON.stringify({ blockIndex: idx, enabled })
          });
          if (res.ok) {
            const data = await res.json();
            adminDisabledBlocks = data.settings.disabledBlocks || [];
            // パネル全体を再描画せず、このスイッチだけを更新することでスクロール位置を保持する
            const isOff = adminDisabledBlocks.includes(idx);
            this.classList.toggle('active', !isOff);
            const labelSpan = this.parentElement.querySelector('span');
            if (labelSpan) {
              labelSpan.textContent = isOff ? 'OFF' : 'ON';
              labelSpan.style.color = isOff ? 'var(--coral)' : 'var(--mint)';
            }
          }
        } catch(e) {}
      });
    });
  }

  adminPanelBtn.addEventListener('click', () => {
    if (currentUserId === 'admin') {
      renderAdminPanel();
      modalOverlay.classList.add('show');
    }
  });

  // ===================== ランキング（リアルタイム自動更新） =====================
  async function renderRankingModal() {
    modalContent.dataset.mode = 'ranking';
    let html = `
      <h2 style="color:var(--gold);">🏆 ランキング</h2>
      <div class="sub">8×8サイズのスコアのみランキング対象です。</div>
      <div class="tab-row" style="margin-bottom:6px;">
        ${RANKING_TYPES.map(t => `
          <button class="tab-btn ${currentRankingType === t ? 'active' : ''}" data-rtype="${t}">${RANKING_TYPE_LABELS[t]}</button>
        `).join('')}
      </div>
      <div class="tab-row" id="modeTabs" style="margin-bottom:10px; ${currentRankingType === 'score' ? '' : 'display:none;'}">
        ${RANKING_MODES.map(m => `
          <button class="tab-btn ${currentRankingMode === m ? 'active' : ''}" data-rmode="${m}">${RANKING_MODE_LABELS[m]}</button>
        `).join('')}
      </div>
      <div id="rankingContent">
        <div class="sub">🔄 読み込み中...</div>
      </div>
      <div style="margin-top:8px; font-size:12px; color:var(--text-dim);">自動更新（5秒ごと）</div>
    `;
    modalContent.innerHTML = html;

    modalContent.querySelectorAll('.tab-btn[data-rtype]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentRankingType = btn.dataset.rtype;
        renderRankingModal();
      });
    });
    modalContent.querySelectorAll('.tab-btn[data-rmode]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentRankingMode = btn.dataset.rmode;
        renderRankingModal();
      });
    });

    // 読み込み関数
    async function loadRanking() {
      try {
        const res = await fetch(`${API_BASE_URL}/api/ranking?mode=${currentRankingMode}&type=${currentRankingType}`);
        const data = await res.json();
        let content = `<div style="text-align:left; max-height:380px; overflow-y:auto;">`;
        if (data.top && data.top.length > 0) {
          data.top.forEach((user, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index+1}.`;
            const isMe = user.id === currentUserId;
            const valueLabel = currentRankingType === 'coins' ? `${user.value}コイン` :
                              currentRankingType === 'playtime' ? `${user.value}秒` :
                              `${user.value}点`;
            content += `
              <div style="display:flex; justify-content:space-between; padding:8px 4px; border-bottom:1px solid rgba(255,255,255,0.05); ${isMe ? 'background:rgba(255,217,61,0.15); border-radius:8px;' : ''}">
                <span style="font-weight:700; ${isMe ? 'color:var(--gold);' : ''}">${medal} ${user.id} ${isMe ? '👈' : ''}</span>
                <span style="color:var(--gold); font-weight:800;">${valueLabel}</span>
              </div>
            `;
          });
        } else {
          const msg = currentRankingType === 'score' ? 'このモードのランキングデータがまだありません。' :
                     currentRankingType === 'coins' ? 'まだコインデータがありません。' :
                     'プレイ時間データがまだありません。';
          content += `<div class="sub">${msg}</div>`;
        }
        content += `</div>`;

        if (authToken && currentUserId) {
          let myValue = 0;
          try {
            const syncRes = await fetch(`${API_BASE_URL}/api/sync`, {
              headers: { 'Authorization': `Bearer ${authToken}` }
            });
            const syncData = await syncRes.json();
            if (currentRankingType === 'coins') {
              myValue = syncData.coins || 0;
            } else if (currentRankingType === 'playtime') {
              myValue = syncData.playTime || 0;
            } else {
              const bestScoresServer = syncData.bestScores || {};
              myValue = bestScoresServer[currentRankingMode] || 0;
            }
          } catch(e) {}

          if (myValue > 0) {
            const higherCount = data.top ? data.top.filter(u => u.value > myValue).length : 0;
            const myInTop = data.top ? data.top.some(u => u.id === currentUserId) : false;
            let rankDisplay = myInTop ? `${data.top.findIndex(u => u.id === currentUserId) + 1}位` :
                             (data.top && data.top.length > 0 ? `${higherCount + 1}位以上` : '-');
            const valueLabel = currentRankingType === 'coins' ? `${myValue}コイン` :
                              currentRankingType === 'playtime' ? `${myValue}秒` :
                              `${myValue}点`;
            content += `
              <div style="margin-top:16px; padding:14px 16px; background:linear-gradient(135deg,var(--panel-light),var(--panel)); border-radius:14px; border:2px solid var(--gold); display:flex; justify-content:space-between; align-items:center; position:sticky; bottom:0; backdrop-filter:blur(8px);">
                <span style="font-weight:700; color:var(--gold);">👤 ${currentUserId} の順位</span>
                <span style="font-weight:800; font-size:20px; color:var(--gold);">
                  ${rankDisplay}
                  <span style="font-size:14px; color:var(--text-dim); font-weight:400; margin-left:8px;">${valueLabel}</span>
                </span>
              </div>
            `;
          } else {
            const msg = currentRankingType === 'score' ? 'まだこのモードのスコアがありません。' :
                       currentRankingType === 'coins' ? 'まだコインがありません。' :
                       'プレイ時間が記録されていません。';
            content += `
              <div style="margin-top:16px; padding:14px 16px; background:var(--panel-light); border-radius:14px; text-align:center; color:var(--text-dim);">
                📊 ${msg}
              </div>
            `;
          }
        } else {
          content += `
            <div style="margin-top:16px; padding:14px 16px; background:var(--panel-light); border-radius:14px; text-align:center; color:var(--text-dim);">
              🔐 ログインすると自分の順位が表示されます
            </div>
          `;
        }
        document.getElementById('rankingContent').innerHTML = content;
      } catch(err) {
        document.getElementById('rankingContent').innerHTML = `<div class="sub" style="color:var(--coral);">❌ ランキングの読み込みに失敗しました</div>`;
      }
    }

    await loadRanking();

    // ポーリング開始（既存のものをクリア）
    if (rankingPollInterval) clearInterval(rankingPollInterval);
    rankingPollInterval = setInterval(loadRanking, 5000);
  }

  rankingBtn.addEventListener('click', () => {
    renderRankingModal();
    modalOverlay.classList.add('show');
  });

  // ===================== チャット =====================
  let chatMessages = [];
  let chatPollingInterval = null;
  let chatLastSeenId = 0;
  let chatUnreadCount = 0;
  let chatMentionCount = 0;

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function escapeRegExp(str){
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlightMentions(text){
    const esc = escapeHtml(text);
    if(!currentUserId) return esc;
    const re = new RegExp('@' + escapeRegExp(currentUserId) + '(?!\\w)', 'gi');
    return esc.replace(re, m => `<span class="mention-tag">${m}</span>`);
  }

  function updateChatBadge(){
    if(chatMentionCount > 0){
      chatMentionBadge.textContent = chatMentionCount > 99 ? '99+' : chatMentionCount;
      chatMentionBadge.classList.add('show');
      chatDot.classList.remove('show');
    } else if(chatUnreadCount > 0){
      chatMentionBadge.classList.remove('show');
      chatDot.classList.add('show');
    } else {
      chatMentionBadge.classList.remove('show');
      chatDot.classList.remove('show');
    }
  }

  // モーダルを開かず裏側で新着とメンションだけチェックする軽量ポーリング
  async function pollChatUnread(){
    try {
      const res = await fetch(`${API_BASE_URL}/api/chat/messages`);
      if(!res.ok) return;
      const data = await res.json();
      if(!data.length) return;
      const maxId = Math.max(...data.map(m => m.id));
      if(chatLastSeenId === 0){ chatLastSeenId = maxId; return; } // 初回は既読扱い
      const isOpen = modalOverlay.classList.contains('show') && modalContent.dataset.mode === 'chat';
      if(isOpen){ chatLastSeenId = maxId; return; } // 開いている間は既読扱い
      const newOnes = data.filter(m => m.id > chatLastSeenId && m.user_id !== currentUserId);
      if(newOnes.length){
        chatUnreadCount += newOnes.length;
        if(currentUserId){
          const re = new RegExp('@' + escapeRegExp(currentUserId) + '(?!\\w)', 'i');
          chatMentionCount += newOnes.filter(m => re.test(m.message)).length;
        }
        updateChatBadge();
      }
      chatLastSeenId = maxId;
    } catch(err) { /* 無視 */ }
  }

  async function fetchChatMessages() {
    try {
      const res = await fetch(`${API_BASE_URL}/api/chat/messages`);
      const data = await res.json();
      chatMessages = data;
      if(data.length) chatLastSeenId = Math.max(...data.map(m => m.id));
      renderChatMessages();
    } catch (err) {
      console.warn('チャット取得失敗:', err);
    }
  }

  async function sendChatMessage(message) {
    if (!authToken) {
      alert('ログインが必要です');
      return false;
    }
    try {
      const res = await fetch(`${API_BASE_URL}/api/chat/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ message })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '送信失敗');
      }
      await fetchChatMessages();
      return true;
    } catch (err) {
      alert(err.message);
      return false;
    }
  }

  async function showProfile(userId) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/user/profile/${userId}`);
      if (!res.ok) throw new Error('ユーザーが見つかりません');
      const data = await res.json();
      modalContent.dataset.mode = 'profile';
      const isFriend = friendsList.some(f => f.id === data.userId);
      const isSelf = data.userId === currentUserId;
      modalContent.innerHTML = `
        <h2 style="color:var(--gold);">👤 ${data.userId} のプロフィール</h2>
        <div style="text-align:left; padding:8px 0;">
          <div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--text-dim);">🏆 ベストスコア</span>
            <span style="color:var(--gold); font-weight:800;">${data.bestScore}点</span>
          </div>
          <div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--text-dim);">🪙 コイン</span>
            <span style="color:var(--gold); font-weight:800;">${data.coins}コイン</span>
          </div>
          <div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--text-dim);">⏱️ プレイ時間</span>
            <span style="color:var(--gold); font-weight:800;">${data.playTime}秒</span>
          </div>
          <div style="display:flex; justify-content:space-between; padding:6px 0;">
            <span style="color:var(--text-dim);">📅 登録日</span>
            <span style="color:var(--text-dim);">${new Date(data.joinedAt).toLocaleDateString('ja-JP')}</span>
          </div>
        </div>
        ${!isSelf && authToken ? (isFriend
          ? `<button class="primary-btn" id="profileDmBtn">💬 DMを送る</button>`
          : `<button class="primary-btn" id="profileAddFriendBtn">➕ フレンド申請</button>`) : ''}
        <button class="ghost-btn" onclick="closeModal()">閉じる</button>
      `;
      modalOverlay.classList.add('show');
      const dmBtn = document.getElementById('profileDmBtn');
      if(dmBtn) dmBtn.addEventListener('click', () => openDMThread(data.userId));
      const addBtn = document.getElementById('profileAddFriendBtn');
      if(addBtn) addBtn.addEventListener('click', () => sendFriendRequest(data.userId));
    } catch (err) {
      alert(err.message);
    }
  }

  function renderChatMessages() {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    if (chatMessages.length === 0) {
      container.innerHTML = `<div style="text-align:center; color:var(--text-dim);">まだメッセージがありません。</div>`;
      return;
    }
    container.innerHTML = chatMessages.map(msg => `
      <div style="display:flex; align-items:baseline; gap:6px; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.03);">
        <span style="color:var(--gold); font-weight:700; cursor:pointer; flex-shrink:0;" onclick="showProfile('${msg.user_id}')">
          [${msg.user_id}]
        </span>
        <span style="color:var(--text); word-break:break-word;">${highlightMentions(msg.message)}</span>
        <span style="color:var(--text-dim); font-size:10px; margin-left:auto; flex-shrink:0;">
          ${new Date(msg.timestamp).toLocaleTimeString('ja-JP')}
        </span>
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  function renderChatModal() {
    modalContent.dataset.mode = 'chat';
    modalContent.innerHTML = `
      <h2 style="color:var(--gold);">💬 グローバルチャット</h2>
      <div class="sub">全ユーザーと会話できます。「@ユーザーID」でメンションできます。</div>
      <div id="chatMessages" style="height:300px; overflow-y:auto; background:var(--bg-deep2); border-radius:12px; padding:10px; margin:8px 0; text-align:left; border:1px solid rgba(255,255,255,0.05);">
        <div style="text-align:center; color:var(--text-dim);">読み込み中...</div>
      </div>
      <div style="display:flex; gap:6px;">
        <input type="text" id="chatInput" placeholder="メッセージを入力...(@IDでメンション)" style="flex:1; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:var(--bg-deep2); color:var(--text); font-size:14px; font-family:'Nunito',sans-serif;">
        <button class="primary-btn" id="chatSendBtn" style="flex-shrink:0; width:auto; padding:10px 20px; margin:0;">送信</button>
      </div>
      <div style="margin-top:6px; text-align:right; font-size:10px; color:var(--text-dim);">最新50件を表示</div>
    `;
    modalOverlay.classList.add('show');

    // 開いたので未読・メンションバッジをリセット
    chatUnreadCount = 0; chatMentionCount = 0; updateChatBadge();

    fetchChatMessages();

    document.getElementById('chatSendBtn').addEventListener('click', async () => {
      const input = document.getElementById('chatInput');
      const msg = input.value.trim();
      if (!msg) return;
      await sendChatMessage(msg);
      input.value = '';
    });

    document.getElementById('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('chatSendBtn').click();
      }
    });

    if (chatPollingInterval) clearInterval(chatPollingInterval);
    chatPollingInterval = setInterval(fetchChatMessages, 3000);
  }

  chatBtn.addEventListener('click', () => {
    renderChatModal();
    // モーダルが閉じられたらポーリング停止
    const observer = new MutationObserver(() => {
      if (!modalOverlay.classList.contains('show')) {
        if (chatPollingInterval) {
          clearInterval(chatPollingInterval);
          chatPollingInterval = null;
        }
      }
    });
    observer.observe(modalOverlay, { attributes: true, attributeFilter: ['class'] });
  });

  // ===================== 🆕 フレンド・DM =====================
  let friendsList = [];
  let incomingRequests = [];
  let outgoingRequests = [];
  let dmThreadWith = null;
  let dmPollingInterval = null;
  let dmUnreadTotal = 0;
  let dmMentionCount = 0;
  let dmPerFriendUnread = {};
  let friendsBgPollInterval = null;
  let chatBgPollInterval = null;
  let duelsList = [];
  let currentDuelId = null;

  function startBackgroundPolling(){
    stopBackgroundPolling();
    fetchFriendsData().then(updateFriendsBadge);
    fetchDMUnreadSummary();
    friendsBgPollInterval = setInterval(async () => {
      await fetchFriendsData();
      await fetchDMUnreadSummary();
    }, 8000);
    chatBgPollInterval = setInterval(pollChatUnread, 5000);
  }

  function stopBackgroundPolling(){
    if (friendsBgPollInterval) { clearInterval(friendsBgPollInterval); friendsBgPollInterval = null; }
    if (chatBgPollInterval) { clearInterval(chatBgPollInterval); chatBgPollInterval = null; }
  }

  function updateFriendsBadge(){
    if (dmMentionCount > 0) {
      friendsMentionBadge.textContent = dmMentionCount > 99 ? '99+' : dmMentionCount;
      friendsMentionBadge.classList.add('show');
      friendsDot.classList.remove('show');
    } else if (dmUnreadTotal > 0 || incomingRequests.length > 0) {
      friendsMentionBadge.classList.remove('show');
      friendsDot.classList.add('show');
    } else {
      friendsMentionBadge.classList.remove('show');
      friendsDot.classList.remove('show');
    }
  }

  async function fetchFriendsData(){
    if (!authToken) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/friends/list`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      friendsList = data.friends || [];
      incomingRequests = data.incoming || [];
      outgoingRequests = data.outgoing || [];
      updateFriendsBadge();
    } catch (err) { /* 無視 */ }
  }

  async function fetchDMUnreadSummary(){
    if (!authToken) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dm/unread-summary`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      dmUnreadTotal = data.total || 0;
      dmMentionCount = data.mentions || 0;
      dmPerFriendUnread = data.perFriend || {};
      updateFriendsBadge();
    } catch (err) { /* 無視 */ }
  }

  async function sendFriendRequest(toId){
    if (!authToken) { alert('ログインが必要です'); return; }
    if (!toId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/friends/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ toId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '申請に失敗しました');
      await fetchFriendsData();
      if (modalContent.dataset.mode === 'friends') renderFriendsModal('requests');
      else if (modalContent.dataset.mode === 'profile') alert('フレンド申請を送りました！');
    } catch (err) { alert(err.message); }
  }

  async function respondFriendRequest(fromId, action){
    try {
      const res = await fetch(`${API_BASE_URL}/api/friends/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ fromId, action })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '処理に失敗しました');
      await fetchFriendsData();
      renderFriendsModal('requests');
    } catch (err) { alert(err.message); }
  }

  async function cancelFriendRequest(toId){
    try {
      await fetch(`${API_BASE_URL}/api/friends/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ toId })
      });
      await fetchFriendsData();
      renderFriendsModal('requests');
    } catch (err) { /* 無視 */ }
  }

  // ===================== 🆕 フレンド対決(タイムアタックで勝負) =====================
  async function fetchDuelsList(){
    if (!authToken) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/duels/list`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      duelsList = data.duels || [];
    } catch (err) { /* 無視 */ }
  }

  async function challengeFriend(opponentId){
    if (!authToken) { alert('ログインが必要です'); return; }
    try {
      const res = await fetch(`${API_BASE_URL}/api/duels/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ opponentId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '対決の申し込みに失敗しました');
      await fetchDuelsList();
      renderFriendsModal('duels');
    } catch (err) { alert(err.message); }
  }

  async function respondDuel(duelId, accept){
    try {
      const res = await fetch(`${API_BASE_URL}/api/duels/${duelId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ accept })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '処理に失敗しました');
      await fetchDuelsList();
      renderFriendsModal('duels');
    } catch (err) { alert(err.message); }
  }

  function playDuel(duel){
    currentDuelId = duel.id;
    closeModal();
    startTimeAttackMode();
  }

  async function submitDuelScore(duelId, finalScore){
    try {
      const res = await fetch(`${API_BASE_URL}/api/duels/${duelId}/submit-score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ score: finalScore })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      return data.duel;
    } catch (err) { return null; }
  }

  function duelResultText(duel){
    const isChallenger = duel.challenger_id === currentUserId;
    const myScore = isChallenger ? duel.challenger_score : duel.opponent_score;
    const oppScore = isChallenger ? duel.opponent_score : duel.challenger_score;
    const oppId = isChallenger ? duel.opponent_id : duel.challenger_id;
    if (duel.status !== 'completed') return `対 ${oppId}：相手の結果を待っています…`;
    if (myScore > oppScore) return `🏆 対 ${oppId} に勝利！（自分 ${myScore} - 相手 ${oppScore}）🪙+200コイン獲得！`;
    if (myScore < oppScore) return `😢 対 ${oppId} に敗北…（自分 ${myScore} - 相手 ${oppScore}）`;
    return `🤝 対 ${oppId} と引き分け（${myScore} - ${oppScore}）🪙+50コイン獲得！`;
  }

  async function removeFriendFn(friendId){
    if (!confirm(`${friendId} をフレンドから削除しますか？\nDMの履歴は残りますが、再度フレンドになるまで送信できません。`)) return;
    try {
      await fetch(`${API_BASE_URL}/api/friends/remove`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ friendId })
      });
      await fetchFriendsData();
      renderFriendsModal('friends');
    } catch (err) { /* 無視 */ }
  }

  async function fetchDMMessages(friendId){
    try {
      const res = await fetch(`${API_BASE_URL}/api/dm/messages/${friendId}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (!res.ok) throw new Error((await res.json()).error || '取得に失敗しました');
      return await res.json();
    } catch (err) { return []; }
  }

  async function sendDM(toId, message){
    try {
      const res = await fetch(`${API_BASE_URL}/api/dm/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ toId, message })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '送信に失敗しました');
      return true;
    } catch (err) { alert(err.message); return false; }
  }

  function renderFriendsModal(tab){
    tab = tab || 'friends';
    modalContent.dataset.mode = 'friends';
    let html = `
      <h2 style="color:var(--gold);">👥 フレンド・DM</h2>
      <div class="tab-row">
        <button class="tab-btn ${tab==='friends'?'active':''}" data-ftab="friends">フレンド</button>
        <button class="tab-btn ${tab==='requests'?'active':''}" data-ftab="requests">リクエスト${incomingRequests.length?` (${incomingRequests.length})`:''}</button>
        <button class="tab-btn ${tab==='dm'?'active':''}" data-ftab="dm">DM</button>
        <button class="tab-btn ${tab==='duels'?'active':''}" data-ftab="duels">⚔️ 対決</button>
      </div>
      <div id="friendsTabBody">`;

    if (tab === 'friends') {
      html += `
        <div class="friend-add-row">
          <input type="text" id="friendAddInput" placeholder="ユーザーIDでフレンド申請...">
          <button class="primary-btn" id="friendAddBtn" style="width:auto; margin:0; padding:10px 16px;">申請</button>
        </div>`;
      if (friendsList.length === 0) {
        html += `<div class="empty-hint">まだフレンドがいません。上の欄にIDを入力して申請しましょう。</div>`;
      } else {
        friendsList.forEach(f => {
          const unread = dmPerFriendUnread[f.id] || 0;
          html += `
            <div class="friend-item">
              <span class="fname" data-showprofile="${f.id}">
                <span class="online-dot ${f.online ? 'on' : 'off'}"></span>${f.id}${unread ? `<span class="funread">${unread}</span>` : ''}
              </span>
              <span class="fsub">${f.online ? '🟢 オンライン' : 'オフライン'}</span>
              <button class="fbtn" data-challenge="${f.id}">⚔️ 対決</button>
              <button class="fbtn remove" data-removefriend="${f.id}">削除</button>
            </div>`;
        });
      }
    } else if (tab === 'duels') {
      const pendingIncoming = duelsList.filter(d => d.status==='pending' && d.opponent_id===currentUserId);
      const pendingOutgoing = duelsList.filter(d => d.status==='pending' && d.challenger_id===currentUserId);
      const playable = duelsList.filter(d => d.status==='accepted' &&
        ((d.challenger_id===currentUserId && d.challenger_score===null) || (d.opponent_id===currentUserId && d.opponent_score===null)));
      const waiting = duelsList.filter(d => d.status==='accepted' &&
        ((d.challenger_id===currentUserId && d.challenger_score!==null) || (d.opponent_id===currentUserId && d.opponent_score!==null)));
      const completed = duelsList.filter(d => d.status==='completed');
      html += `<div class="sub" style="margin-bottom:8px;">タイムアタック(${TIME_ATTACK_DURATION}秒)でフレンドと勝負！フレンド一覧の「⚔️対決」から挑戦できます。</div>`;
      html += `<div class="qtitle" style="margin:10px 0 6px;">📥 届いている挑戦</div>`;
      html += pendingIncoming.length===0 ? `<div class="empty-hint">届いている挑戦はありません。</div>` :
        pendingIncoming.map(d=>`
          <div class="friend-item pending">
            <span class="fname">⚔️ ${d.challenger_id}</span>
            <button class="fbtn accept" data-duelaccept="${d.id}">受ける</button>
            <button class="fbtn decline" data-dueldecline="${d.id}">断る</button>
          </div>`).join('');
      html += `<div class="qtitle" style="margin:14px 0 6px;">🎮 プレイ可能な対決</div>`;
      html += playable.length===0 ? `<div class="empty-hint">プレイ可能な対決はありません。</div>` :
        playable.map(d=>{
          const opp = d.challenger_id===currentUserId ? d.opponent_id : d.challenger_id;
          return `
          <div class="friend-item chat">
            <span class="fname">⚔️ 対 ${opp}</span>
            <button class="fbtn" data-duelplay="${d.id}">プレイする</button>
          </div>`;
        }).join('');
      html += `<div class="qtitle" style="margin:14px 0 6px;">⏳ 結果待ち・送信済みの挑戦</div>`;
      const pendingAndWaiting = [...pendingOutgoing, ...waiting];
      html += pendingAndWaiting.length===0 ? `<div class="empty-hint">ありません。</div>` :
        pendingAndWaiting.map(d=>{
          const opp = d.challenger_id===currentUserId ? d.opponent_id : d.challenger_id;
          return `<div class="friend-item pending"><span class="fname">⚔️ 対 ${opp}</span><span class="fsub">結果待ち…</span></div>`;
        }).join('');
      html += `<div class="qtitle" style="margin:14px 0 6px;">🏁 完了した対決</div>`;
      html += completed.length===0 ? `<div class="empty-hint">まだありません。</div>` :
        completed.slice(0,10).map(d=>`<div class="friend-item"><span class="fname" style="flex:1;">${duelResultText(d)}</span></div>`).join('');
    } else if (tab === 'requests') {
      html += `<div class="qtitle" style="margin-bottom:6px;">📥 届いている申請</div>`;
      if (incomingRequests.length === 0) {
        html += `<div class="empty-hint">届いている申請はありません。</div>`;
      } else {
        incomingRequests.forEach(r => {
          html += `
            <div class="friend-item pending">
              <span class="fname" data-showprofile="${r.id}">🔔 ${r.id}</span>
              <button class="fbtn accept" data-accept="${r.id}">承認</button>
              <button class="fbtn decline" data-decline="${r.id}">拒否</button>
            </div>`;
        });
      }
      html += `<div class="qtitle" style="margin:14px 0 6px;">📤 送信した申請</div>`;
      if (outgoingRequests.length === 0) {
        html += `<div class="empty-hint">送信中の申請はありません。</div>`;
      } else {
        outgoingRequests.forEach(r => {
          html += `
            <div class="friend-item pending">
              <span class="fname">📤 ${r.id}</span>
              <span class="fsub">承認待ち</span>
              <button class="fbtn decline" data-cancel="${r.id}">取消</button>
            </div>`;
        });
      }
    } else if (tab === 'dm') {
      if (friendsList.length === 0) {
        html += `<div class="empty-hint">DMはフレンドとのみ可能です。まずはフレンドになりましょう。</div>`;
      } else {
        friendsList.forEach(f => {
          const unread = dmPerFriendUnread[f.id] || 0;
          html += `
            <div class="friend-item chat" data-openthread="${f.id}" style="cursor:pointer;">
              <span class="fname">💬 ${f.id}${unread ? `<span class="funread">${unread}</span>` : ''}</span>
              <span class="fsub">タップして会話を開く →</span>
            </div>`;
        });
      }
    }
    html += `</div>`;
    modalContent.innerHTML = html;

    modalContent.querySelectorAll('.tab-btn[data-ftab]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.ftab === 'duels') await fetchDuelsList();
        renderFriendsModal(btn.dataset.ftab);
      });
    });
    const addBtn = document.getElementById('friendAddBtn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const input = document.getElementById('friendAddInput');
        const val = input.value.trim();
        if (!val) return;
        sendFriendRequest(val);
        input.value = '';
      });
    }
    modalContent.querySelectorAll('[data-showprofile]').forEach(el => {
      el.addEventListener('click', () => showProfile(el.dataset.showprofile));
    });
    modalContent.querySelectorAll('[data-dm]').forEach(el => {
      el.addEventListener('click', () => openDMThread(el.dataset.dm));
    });
    modalContent.querySelectorAll('[data-removefriend]').forEach(el => {
      el.addEventListener('click', () => removeFriendFn(el.dataset.removefriend));
    });
    modalContent.querySelectorAll('[data-accept]').forEach(el => {
      el.addEventListener('click', () => respondFriendRequest(el.dataset.accept, 'accept'));
    });
    modalContent.querySelectorAll('[data-decline]').forEach(el => {
      el.addEventListener('click', () => respondFriendRequest(el.dataset.decline, 'decline'));
    });
    modalContent.querySelectorAll('[data-cancel]').forEach(el => {
      el.addEventListener('click', () => cancelFriendRequest(el.dataset.cancel));
    });
    modalContent.querySelectorAll('[data-openthread]').forEach(el => {
      el.addEventListener('click', () => openDMThread(el.dataset.openthread));
    });
    modalContent.querySelectorAll('[data-challenge]').forEach(el => {
      el.addEventListener('click', () => challengeFriend(el.dataset.challenge));
    });
    modalContent.querySelectorAll('[data-duelaccept]').forEach(el => {
      el.addEventListener('click', () => respondDuel(el.dataset.duelaccept, true));
    });
    modalContent.querySelectorAll('[data-dueldecline]').forEach(el => {
      el.addEventListener('click', () => respondDuel(el.dataset.dueldecline, false));
    });
    modalContent.querySelectorAll('[data-duelplay]').forEach(el => {
      el.addEventListener('click', () => {
        const duel = duelsList.find(d => String(d.id)===el.dataset.duelplay);
        if (duel) playDuel(duel);
      });
    });
  }

  async function openDMThread(friendId){
    dmThreadWith = friendId;
    modalContent.dataset.mode = 'dmthread';
    const initial = (friendId||'?').charAt(0).toUpperCase();
    modalContent.innerHTML = `
      <div class="dm-thread-header">
        <button class="dm-thread-back" id="dmBackBtn">←</button>
        <div class="dm-thread-avatar">${initial}</div>
        <div class="dm-thread-title"><b>${friendId}</b><span>💬 ダイレクトメッセージ</span></div>
      </div>
      <div id="dmMessages" style="height:300px; overflow-y:auto; background:var(--bg-deep2); border-radius:12px; padding:10px; margin:8px 0; border:1px solid rgba(255,255,255,0.05);">
        <div class="empty-hint">読み込み中...</div>
      </div>
      <div style="display:flex; gap:6px;">
        <input type="text" id="dmInput" placeholder="メッセージを入力...(@IDでメンション)" style="flex:1; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:var(--bg-deep2); color:var(--text); font-size:14px; font-family:'Nunito',sans-serif;">
        <button class="primary-btn" id="dmSendBtn" style="flex-shrink:0; width:auto; padding:10px 20px; margin:0;">送信</button>
      </div>
    `;

    async function loadThread(){
      const msgs = await fetchDMMessages(friendId);
      const container = document.getElementById('dmMessages');
      if (!container) return;
      if (msgs.length === 0) {
        container.innerHTML = `<div class="empty-hint">まだメッセージがありません。話しかけてみましょう！</div>`;
      } else {
        container.innerHTML = msgs.map(m => {
          const mine = m.from_id === currentUserId;
          return `
            <div class="dm-bubble-row ${mine ? 'mine' : ''}">
              <div class="dm-bubble-col">
                <div class="dm-bubble">${highlightMentions(m.message)}</div>
                <div class="dm-time" style="text-align:${mine ? 'right' : 'left'};">${new Date(m.timestamp).toLocaleTimeString('ja-JP')}</div>
              </div>
            </div>`;
        }).join('');
      }
      container.scrollTop = container.scrollHeight;
      fetchDMUnreadSummary(); // 既読になったのでバッジを更新
    }
    await loadThread();

    document.getElementById('dmSendBtn').addEventListener('click', async () => {
      const input = document.getElementById('dmInput');
      const msg = input.value.trim();
      if (!msg) return;
      const ok = await sendDM(friendId, msg);
      if (ok) { input.value = ''; await loadThread(); }
    });
    document.getElementById('dmInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('dmSendBtn').click();
    });
    document.getElementById('dmBackBtn').addEventListener('click', () => {
      dmThreadWith = null;
      renderFriendsModal('dm');
    });

    if (dmPollingInterval) clearInterval(dmPollingInterval);
    dmPollingInterval = setInterval(loadThread, 3000);
  }

  friendsBtn.addEventListener('click', async () => {
    if (!authToken) { alert('ログインするとフレンド・DM機能が使えます'); return; }
    // 先にモーダルを開いて「読み込み中」を見せ、通信が終わってから中身を差し替える
    // (以前は通信完了までモーダル自体が開かず、待ち時間があるように感じられていた)
    modalContent.dataset.mode = 'friends';
    modalContent.innerHTML = `<h2 style="color:var(--gold);">👥 フレンド・DM</h2><div class="empty-hint">読み込み中...</div>`;
    modalOverlay.classList.add('show');
    const observer = new MutationObserver(() => {
      if (!modalOverlay.classList.contains('show')) {
        if (dmPollingInterval) { clearInterval(dmPollingInterval); dmPollingInterval = null; }
        dmThreadWith = null;
      }
    });
    observer.observe(modalOverlay, { attributes: true, attributeFilter: ['class'] });
    await fetchFriendsData();
    await fetchDMUnreadSummary();
    if (modalOverlay.classList.contains('show')) {
      renderFriendsModal(incomingRequests.length ? 'requests' : 'friends');
    }
  });

  // ===================== テトリスモード =====================
  const TETRIS_COLS = 10, TETRIS_ROWS = 20;
  const TETROMINOES = {
    I: { matrix:[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], color:2 },
    O: { matrix:[[1,1],[1,1]], color:6 },
    T: { matrix:[[0,1,0],[1,1,1],[0,0,0]], color:3 },
    S: { matrix:[[0,1,1],[1,1,0],[0,0,0]], color:1 },
    Z: { matrix:[[1,1,0],[0,1,1],[0,0,0]], color:0 },
    J: { matrix:[[1,0,0],[1,1,1],[0,0,0]], color:4 },
    L: { matrix:[[0,0,1],[1,1,1],[0,0,0]], color:5 }
  };
  const TETROMINO_KEYS = Object.keys(TETROMINOES);
  const TETRIS_LINE_LABELS = { 1:'シングル!', 2:'ダブル!', 3:'トリプル!', 4:'テトリス!!' };
  const TETRIS_LINE_POINTS = { 1:100, 2:300, 3:500, 4:800 };

  let tetrisActive = false, tetrisGameOver = false;
  let tetrisGrid = null, tetrisPiece = null, tetrisNextType = null, tetrisBag = [];
  let tetrisScore = 0, tetrisLevel = 1, tetrisLines = 0, tetrisCombo = 0, tetrisBackToBack = false;
  let tetrisTimer = null, tetrisCellEls = [];
  let tetrisBest = 0;
  let tetrisHoldType = null, tetrisHoldUsed = false;

  function rotateMatrixCW(m){
    const n = m.length;
    const res = Array.from({length:n}, ()=>Array(n).fill(0));
    for(let r=0;r<n;r++) for(let c=0;c<n;c++) res[c][n-1-r] = m[r][c];
    return res;
  }

  function pad4x4(matrix){
    const n = matrix.length;
    const res = Array.from({length:4}, ()=>Array(4).fill(0));
    const offset = Math.floor((4-n)/2);
    for(let r=0;r<n;r++) for(let c=0;c<n;c++) res[r+offset][c+offset] = matrix[r][c];
    return res;
  }

  function tetrisRandomType(){
    if(!tetrisBag || tetrisBag.length===0){
      tetrisBag = [...TETROMINO_KEYS];
      for(let i=tetrisBag.length-1;i>0;i--){
        const j = Math.floor(Math.random()*(i+1));
        [tetrisBag[i], tetrisBag[j]] = [tetrisBag[j], tetrisBag[i]];
      }
    }
    return tetrisBag.pop();
  }

  function tetrisCollides(matrix, row, col){
    for(let r=0;r<matrix.length;r++){
      for(let c=0;c<matrix[r].length;c++){
        if(!matrix[r][c]) continue;
        const gr = row+r, gc = col+c;
        if(gc<0 || gc>=TETRIS_COLS || gr>=TETRIS_ROWS) return true;
        if(gr>=0 && tetrisGrid[gr][gc] !== -1) return true;
      }
    }
    return false;
  }

  function initTetrisBoard(){
    tetrisBoardEl.innerHTML = '';
    tetrisCellEls = [];
    for(let i=0;i<TETRIS_ROWS*TETRIS_COLS;i++){
      const cell = document.createElement('div');
      cell.className = 'tetris-cell';
      tetrisBoardEl.appendChild(cell);
      tetrisCellEls.push(cell);
    }
  }

  function paintTetrisPiece(matrix, row, col, colorIdx, isGhost){
    for(let r=0;r<matrix.length;r++){
      for(let c=0;c<matrix[r].length;c++){
        if(!matrix[r][c]) continue;
        const gr = row+r, gc = col+c;
        if(gr<0 || gr>=TETRIS_ROWS || gc<0 || gc>=TETRIS_COLS) continue;
        const cell = tetrisCellEls[gr*TETRIS_COLS+gc];
        if(isGhost){
          if(!cell.classList.contains('filled')) cell.classList.add('ghost');
        } else {
          cell.classList.add('filled');
          cell.classList.remove('ghost');
          cell.style.background = COLORS[colorIdx].bg;
        }
      }
    }
  }

  function renderTetrisNext(){
    tetrisNextEl.innerHTML = '';
    if(!tetrisNextType) return;
    const def = TETROMINOES[tetrisNextType];
    const m = pad4x4(def.matrix);
    for(let r=0;r<4;r++){
      for(let c=0;c<4;c++){
        const cell = document.createElement('div');
        cell.className = 'tetris-next-cell';
        if(m[r][c]) cell.style.background = COLORS[def.color].bg;
        else cell.classList.add('empty');
        tetrisNextEl.appendChild(cell);
      }
    }
  }

  function renderTetrisHold(){
    tetrisHoldBoxEl.innerHTML = '';
    tetrisHoldBoxEl.classList.toggle('used', tetrisHoldUsed);
    if(!tetrisHoldType) return;
    const def = TETROMINOES[tetrisHoldType];
    const m = pad4x4(def.matrix);
    for(let r=0;r<4;r++){
      for(let c=0;c<4;c++){
        const cell = document.createElement('div');
        cell.className = 'tetris-next-cell';
        if(m[r][c]) cell.style.background = COLORS[def.color].bg;
        else cell.classList.add('empty');
        tetrisHoldBoxEl.appendChild(cell);
      }
    }
  }

  function renderTetris(){
    for(let r=0;r<TETRIS_ROWS;r++){
      for(let c=0;c<TETRIS_COLS;c++){
        const idx = r*TETRIS_COLS+c;
        const cell = tetrisCellEls[idx];
        const val = tetrisGrid[r][c];
        cell.className = 'tetris-cell';
        cell.style.background = (val!==-1) ? COLORS[val].bg : '';
        if(val!==-1) cell.classList.add('filled');
      }
    }
    if(tetrisPiece){
      let ghostRow = tetrisPiece.row;
      while(!tetrisCollides(tetrisPiece.matrix, ghostRow+1, tetrisPiece.col)) ghostRow++;
      paintTetrisPiece(tetrisPiece.matrix, ghostRow, tetrisPiece.col, null, true);
      paintTetrisPiece(tetrisPiece.matrix, tetrisPiece.row, tetrisPiece.col, tetrisPiece.color, false);
    }
    renderTetrisNext();
    renderTetrisHold();
    tetrisLevelEl.textContent = tetrisLevel;
    tetrisLinesEl.textContent = tetrisLines;
  }

  function tetrisDropIntervalMs(){
    return Math.max(90, 1000 - (tetrisLevel-1)*70);
  }
  function tetrisStopLoop(){
    if(tetrisTimer){ clearInterval(tetrisTimer); tetrisTimer = null; }
  }
  function tetrisStartLoop(){
    tetrisStopLoop();
    tetrisTimer = setInterval(tetrisTick, tetrisDropIntervalMs());
  }
  function tetrisTick(){
    if(!tetrisActive || tetrisGameOver) return;
    if(!tetrisCollides(tetrisPiece.matrix, tetrisPiece.row+1, tetrisPiece.col)){
      tetrisPiece.row++;
      renderTetris();
    } else {
      tetrisLockPiece();
    }
  }

  function tetrisSpawnPiece(){
    const type = tetrisNextType || tetrisRandomType();
    tetrisNextType = tetrisRandomType();
    const def = TETROMINOES[type];
    const matrix = def.matrix.map(row=>row.slice());
    const col = Math.floor((TETRIS_COLS - matrix.length)/2);
    const row = -1;
    tetrisPiece = { type, matrix, color: def.color, row, col };
    if(tetrisCollides(matrix, row, col)){
      tetrisTriggerGameOver();
      return;
    }
    renderTetris();
    tetrisStartLoop();
  }

  function tetrisMove(dx){
    if(!tetrisActive || tetrisGameOver || !tetrisPiece) return;
    const nc = tetrisPiece.col+dx;
    if(!tetrisCollides(tetrisPiece.matrix, tetrisPiece.row, nc)){
      tetrisPiece.col = nc;
      renderTetris();
    }
  }

  function tetrisRotate(){
    if(!tetrisActive || tetrisGameOver || !tetrisPiece || tetrisPiece.type==='O') return;
    const rotated = rotateMatrixCW(tetrisPiece.matrix);
    const kicks = [0,-1,1,-2,2];
    for(const k of kicks){
      if(!tetrisCollides(rotated, tetrisPiece.row, tetrisPiece.col+k)){
        tetrisPiece.matrix = rotated;
        tetrisPiece.col += k;
        renderTetris();
        return;
      }
    }
  }

  function tetrisSoftDrop(){
    if(!tetrisActive || tetrisGameOver || !tetrisPiece) return;
    if(!tetrisCollides(tetrisPiece.matrix, tetrisPiece.row+1, tetrisPiece.col)){
      tetrisPiece.row++;
      tetrisScore += 1;
      scoreValEl.textContent = tetrisScore;
      renderTetris();
    } else {
      tetrisLockPiece();
    }
  }

  function tetrisHardDrop(){
    if(!tetrisActive || tetrisGameOver || !tetrisPiece) return;
    let dist = 0;
    while(!tetrisCollides(tetrisPiece.matrix, tetrisPiece.row+1, tetrisPiece.col)){
      tetrisPiece.row++;
      dist++;
    }
    if(dist>0){
      tetrisScore += dist*2;
      scoreValEl.textContent = tetrisScore;
    }
    tetrisLockPiece();
  }

  // ===================== ホールド(テトリス99のように現在のピースを保持/交換) =====================
  function tetrisHoldSwap(){
    if(!tetrisActive || tetrisGameOver || !tetrisPiece || tetrisHoldUsed) return;
    const currentType = tetrisPiece.type;
    tetrisHoldUsed = true;
    if(tetrisHoldType === null){
      tetrisHoldType = currentType;
      tetrisSpawnPiece(); // ネクストから補充(ホールドが空の場合)
    } else {
      const swapType = tetrisHoldType;
      tetrisHoldType = currentType;
      const def = TETROMINOES[swapType];
      const matrix = def.matrix.map(row=>row.slice());
      const col = Math.floor((TETRIS_COLS - matrix.length)/2);
      if(tetrisCollides(matrix, -1, col)){ tetrisTriggerGameOver(); return; }
      tetrisPiece = { type:swapType, matrix, color:def.color, row:-1, col };
      renderTetris();
      tetrisStartLoop();
    }
    renderTetrisHold();
  }

  function showTetrisCombo(msg, cls){
    tetrisComboTextEl.textContent = msg;
    tetrisComboTextEl.className = 'combo-text show' + (cls ? (' '+cls) : '');
    setTimeout(()=>{ tetrisComboTextEl.className = 'combo-text'; }, 900);
  }

  function tetrisFloatCoin(amount){
    const rect = tetrisBoardEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'coin-float';
    el.textContent = `+${amount}🪙`;
    el.style.left = (rect.left+rect.width/2-20)+'px';
    el.style.top = (rect.top+rect.height/2)+'px';
    el.style.animation = 'coinFloat 0.9s ease-out forwards';
    document.body.appendChild(el);
    setTimeout(()=>el.remove(), 950);
  }

  function tetrisClearRowsAnimated(rows, cb){
    rows.forEach(r=>{
      for(let c=0;c<TETRIS_COLS;c++){
        const cell = tetrisCellEls[r*TETRIS_COLS+c];
        if(cell) cell.classList.add('clearing');
      }
    });
    setTimeout(cb, 320);
  }

  function tetrisCollapseRows(rows){
    rows.slice().sort((a,b)=>a-b).forEach(r=>{
      tetrisGrid.splice(r,1);
      tetrisGrid.unshift(new Array(TETRIS_COLS).fill(-1));
    });
  }

  function tetrisLockPiece(){
    tetrisStopLoop();
    tetrisHoldUsed = false; // 新しいピースになったのでホールドをまた使えるようにする
    const { matrix, row, col, color } = tetrisPiece;
    let offBoard = false;
    for(let r=0;r<matrix.length;r++){
      for(let c=0;c<matrix[r].length;c++){
        if(!matrix[r][c]) continue;
        const gr = row+r, gc = col+c;
        if(gr<0){ offBoard = true; continue; }
        tetrisGrid[gr][gc] = color;
      }
    }
    if(offBoard){ tetrisTriggerGameOver(); return; }

    const cleared = [];
    for(let r=0;r<TETRIS_ROWS;r++){
      if(tetrisGrid[r].every(v=>v!==-1)) cleared.push(r);
    }

    if(cleared.length>0){
      tetrisCombo++;
      const isTetris4 = cleared.length===4;
      let gained = TETRIS_LINE_POINTS[cleared.length] * tetrisLevel;
      const comboBonus = tetrisCombo>1 ? Math.round(50 * tetrisCombo * tetrisLevel) : 0;
      const btbMult = (isTetris4 && tetrisBackToBack) ? 1.5 : 1;
      tetrisBackToBack = isTetris4;
      gained = Math.round(gained*btbMult) + comboBonus;
      tetrisScore += gained;
      tetrisLines += cleared.length;
      tetrisLevel = Math.floor(tetrisLines/10)+1;

      animateNumberTo(scoreValEl, tetrisScore);
      if(tetrisScore > tetrisBest){
        tetrisBest = tetrisScore;
        bestScores.tetris = tetrisBest;
        saveBestScores();
        animateNumberTo(bestValEl, tetrisBest);
      }

      let msg = TETRIS_LINE_LABELS[cleared.length] || `${cleared.length}ライン!`;
      if(tetrisCombo>1) msg += ` ${tetrisCombo}コンボ!`;
      msg += ` +${gained}`;
      showTetrisCombo(msg, isTetris4 ? 'mega' : (tetrisCombo>1 ? 'bonus' : ''));
      playSound('clear', isTetris4 ? 4 : cleared.length);
      if(tetrisCombo>=3) playSound('coin');

      tetrisClearRowsAnimated(cleared, ()=>{
        tetrisCollapseRows(cleared);
        tetrisSpawnPiece();
      });
      return;
    }

    tetrisCombo = 0;
    playSound('place');
    tetrisSpawnPiece();
  }

  function tetrisTriggerGameOver(){
    if(tetrisGameOver) return;
    tetrisGameOver = true;
    tetrisActive = false;
    tetrisStopLoop();
    playSound('gameover');
    grantBattlePassXp(tetrisScore);
    const earned = Math.max(0, Math.floor(tetrisScore/40));
    if(earned>0){
      coins += earned;
      updateCoinUI();
      tetrisFloatCoin(earned);
      playSound('coin');
    }
    const isNewBest = tetrisScore >= tetrisBest && tetrisScore > 0;
    finalScoreEl.textContent = tetrisScore;
    newBestNoteEl.textContent = isNewBest ? '🎉 ハイスコア更新！' : 'お疲れさまでした！';
    coinEarnedNoteEl.textContent = earned>0 ? `🪙 +${earned} コイン獲得！` : '';
    overlayEl.classList.add('show');
    if(authToken){
      fetch(`${API_BASE_URL}/api/sync`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${authToken}` },
        body: JSON.stringify({ bestScore: tetrisBest, coins, mode:'tetris', size:8, playTime })
      }).catch(()=>{});
    }
    syncPlayTime();
  }

  function restartTetris(){
    tetrisStopLoop();
    tetrisGrid = Array.from({length:TETRIS_ROWS}, ()=>new Array(TETRIS_COLS).fill(-1));
    tetrisScore = 0; tetrisLevel = 1; tetrisLines = 0; tetrisCombo = 0; tetrisBackToBack = false;
    tetrisGameOver = false; tetrisActive = true; tetrisBag = [];
    tetrisHoldType = null; tetrisHoldUsed = false;
    tetrisNextType = tetrisRandomType();
    initTetrisBoard();
    scoreValEl.textContent = '0';
    bestValEl.textContent = tetrisBest;
    renderTetrisHold();
    tetrisSpawnPiece();
  }

  // テトリスモード中は、CSSのtouch-action等に加えてピンチズーム自体をJSでも完全にブロックする
  function preventMultiTouchZoom(e){
    if(e.touches && e.touches.length > 1) e.preventDefault();
  }
  function enterTetrisMode(){
    currentMode = 'tetris';
    updateModeBadge();
    boardWrapEl.style.display = 'none';
    trayEl.style.display = 'none';
    tetrisWrapEl.style.display = 'flex';
    saveSettings();
    startPlayTimeTracking();
    restartTetris();
    document.addEventListener('touchmove', preventMultiTouchZoom, { passive:false });
    document.addEventListener('touchstart', preventMultiTouchZoom, { passive:false });
  }

  function exitTetrisMode(){
    tetrisStopLoop();
    tetrisActive = false;
    tetrisWrapEl.style.display = 'none';
    boardWrapEl.style.display = '';
    trayEl.style.display = '';
    document.removeEventListener('touchmove', preventMultiTouchZoom, { passive:false });
    document.removeEventListener('touchstart', preventMultiTouchZoom, { passive:false });
  }

  // 数字が「1→2→3→…」と駆け上がるように見えるカウントアップアニメーション（約0.8秒以内）
  function animateNumberTo(el, toValue, duration){
    duration = duration || 800;
    const fromValue = parseInt(el.textContent, 10) || 0;
    if(fromValue === toValue){ el.textContent = toValue; return; }
    const start = performance.now();
    function step(now){
      const p = Math.min(1, (now-start)/duration);
      const eased = 1 - Math.pow(1-p, 3);
      const cur = Math.round(fromValue + (toValue-fromValue)*eased);
      el.textContent = cur;
      if(p<1) requestAnimationFrame(step);
      else el.textContent = toValue;
    }
    requestAnimationFrame(step);
  }

  // ===================== テトリス操作(キーボード) =====================
  document.addEventListener('keydown', (e)=>{
    if(currentMode!=='tetris' || !tetrisActive || tetrisGameOver) return;
    const key = e.key.toLowerCase();
    const isSpace = key===' ' || key==='spacebar' || e.code==='Space';
    if(['arrowleft','arrowright','arrowup','arrowdown','a','d','w','s','q'].includes(key) || isSpace) e.preventDefault();
    // 十字キーに加えて、片手操作しやすいようWASDにも対応。ホールドはQ。
    if(key==='arrowleft' || key==='a') tetrisMove(-1);
    else if(key==='arrowright' || key==='d') tetrisMove(1);
    else if(key==='arrowup' || key==='w') tetrisRotate();
    else if(key==='arrowdown' || key==='s') tetrisSoftDrop();
    else if(isSpace) tetrisHardDrop();
    else if(key==='q') tetrisHoldSwap();
  });

  // ===================== テトリス操作(タッチ/タップ・iPad対応) =====================
  function bindTetrisHoldButton(el, fn, repeatMs, initialDelay){
    repeatMs = repeatMs || 100; initialDelay = initialDelay || 220;
    let holdTimer = null, startTimer = null;
    const start = (e)=>{
      e.preventDefault();
      fn();
      startTimer = setTimeout(()=>{ holdTimer = setInterval(fn, repeatMs); }, initialDelay);
    };
    const stop = ()=>{
      clearTimeout(startTimer); clearInterval(holdTimer);
      startTimer = null; holdTimer = null;
    };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('pointercancel', stop);
  }
  bindTetrisHoldButton(tBtnLeftEl, ()=>tetrisMove(-1));
  bindTetrisHoldButton(tBtnRightEl, ()=>tetrisMove(1));
  bindTetrisHoldButton(tBtnSoftEl, ()=>tetrisSoftDrop());
  tBtnRotateEl.addEventListener('pointerdown', (e)=>{ e.preventDefault(); tetrisRotate(); });
  tBtnHardEl.addEventListener('pointerdown', (e)=>{ e.preventDefault(); tetrisHardDrop(); });
  tBtnHoldEl.addEventListener('pointerdown', (e)=>{ e.preventDefault(); tetrisHoldSwap(); });
  tetrisBoardEl.addEventListener('pointerdown', (e)=>{ e.preventDefault(); tetrisRotate(); });
  // ズームや長押しでの範囲選択・コピーメニューが出ないように抑制
  tetrisWrapEl.addEventListener('contextmenu', (e)=>e.preventDefault());
  tetrisWrapEl.addEventListener('selectstart', (e)=>e.preventDefault());

  // ===================== 操作説明パネル =====================
  tetrisHelpPanelEl.innerHTML = `
    <b>🎮 操作説明</b>
    ◀▶：左右移動<br>
    ⟳：回転<br>
    ▼：ソフトドロップ<br>
    ⤓：ハードドロップ<br>
    ⇄ HOLD：ピースを保持/交換<br>
    <b style="margin-top:8px;">⌨️ キーボード</b>
    ← → / A D：移動<br>
    ↑ / W：回転<br>
    ↓ / S：ソフトドロップ<br>
    スペース：ハードドロップ<br>
    Q：ホールド
  `;
  tetrisHelpBtnEl.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    e.stopPropagation();
    tetrisHelpPanelEl.classList.toggle('show');
  });

  // ===================== サーバーお知らせ(管理者コマンド /announce の配信を表示) =====================
  const STORAGE_LAST_ANNOUNCEMENT = 'candyblast-last-announcement-v1';
  let lastSeenAnnouncementId = 0;

  async function loadLastSeenAnnouncement(){
    try{
      const res = await appStorage.get(STORAGE_LAST_ANNOUNCEMENT, false);
      if(res && res.value) lastSeenAnnouncementId = parseInt(res.value,10) || 0;
    }catch(err){}
  }
  async function saveLastSeenAnnouncement(id){
    try{ await appStorage.set(STORAGE_LAST_ANNOUNCEMENT, String(id), false); }catch(err){}
  }

  function showAnnouncementToast(message){
    const el = document.createElement('div');
    el.className = 'announce-toast';
    el.innerHTML = `<span>📢</span><span class="announce-text">${escapeHtml(message)}</span><button class="announce-close">✕</button>`;
    document.body.appendChild(el);
    el.querySelector('.announce-close').addEventListener('click', ()=>el.remove());
    requestAnimationFrame(()=> el.classList.add('show'));
    setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=>el.remove(), 450); }, 8000);
  }

  async function checkAnnouncements(){
    try{
      const r = await fetch(`${API_BASE_URL}/api/announcements/latest`);
      const data = await r.json();
      if(data.announcement && data.announcement.id > lastSeenAnnouncementId){
        lastSeenAnnouncementId = data.announcement.id;
        saveLastSeenAnnouncement(lastSeenAnnouncementId);
        showAnnouncementToast(data.announcement.message);
      }
    }catch(err){}
  }

  // ===================== アップデート検知(新しいバージョンが公開されたらリアルタイムで案内) =====================
  const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || '0';
  let updateToastShown = false;
  async function checkForUpdate(){
    if(updateToastShown) return;
    try{
      const r = await fetch(location.pathname + '?_check=' + Date.now(), { cache:'no-store' });
      const text = await r.text();
      const match = text.match(/name="app-version" content="([^"]+)"/);
      if(match && match[1] && match[1] !== APP_VERSION){
        updateToastShown = true;
        const el = document.createElement('div');
        el.className = 'update-toast';
        el.innerHTML = `<span>✨ 新しいバージョンがあります</span><button id="updateReloadBtn">今すぐ更新</button>`;
        document.body.appendChild(el);
        requestAnimationFrame(()=> el.classList.add('show'));
        document.getElementById('updateReloadBtn').addEventListener('click', ()=>location.reload());
      }
    }catch(err){}
  }

  // ===================== メインメニュー画面 =====================
  const titleScreenEl = document.getElementById('titleScreen');

  function showTitleScreen(){
    if(currentMode==='tetris') exitTetrisMode();
    if(currentMode==='timeattack') stopTimeAttackTimer();
    overlayEl.classList.remove('show');
    modalOverlay.classList.remove('show');
    titleScreenEl.classList.remove('hidden');
  }
  function hideTitleScreen(){
    titleScreenEl.classList.add('hidden');
  }

  document.getElementById('titleStartBtn').addEventListener('click', ()=>{
    hideTitleScreen();
    pendingMode = (currentMode==='tetris' || currentMode==='timeattack') ? 'baked' : currentMode;
    pendingSize = SIZE;
    renderSettingsModal('mode');
    modalOverlay.classList.add('show');
  });
  document.getElementById('titleTimeAttackBtn').addEventListener('click', ()=>{
    hideTitleScreen();
    startTimeAttackMode();
  });
  document.getElementById('titleWeeklyBtn').addEventListener('click', ()=>{
    hideTitleScreen();
    openWeeklyChallengeModal();
  });
  document.getElementById('titleGachaBtn').addEventListener('click', ()=>{
    hideTitleScreen();
    openGachaModal();
  });
  document.getElementById('titleBattlePassBtn').addEventListener('click', ()=>{
    hideTitleScreen();
    openBattlePassModal();
  });
  document.getElementById('titleRecordsBtn').addEventListener('click', ()=>{
    hideTitleScreen();
    renderRecordsModal();
    modalOverlay.classList.add('show');
  });
  document.getElementById('titleSettingsBtn').addEventListener('click', ()=>{
    hideTitleScreen();
    renderAppSettingsModal();
    modalOverlay.classList.add('show');
  });

  // ===================== 更新履歴 / バージョン表示 =====================
  const CHANGELOG = [
    { version:'2.0.2', date:'2026-09-07', items:[
      '📮 設定画面に「ご要望・不具合報告」を新設。ご要望と不具合報告を分けて送信でき、不具合報告には画像を添付可能に',
      '🐞 スキンが数秒後に元に戻ってしまうバグを修正',
      '🎨 スキン一覧を価格順に並び替え',
      '📜 更新履歴に「過去の履歴」を見られるページを追加'
    ]},
    { version:'2.0.1', date:'2026-09-07', items:[
      '⏱ タイムアタックモードのランキングを追加',
      '🔥 イベント機能を追加',
      '🔐 ログイン状態がリロードしても保持されるように改善',
      'その他のバグ修正',
      '',
      '📅 今後の予定',
      'リクエストに応えられるよう、要望を送信できるようにする',
      'フレンドとの対戦で、追加報酬が出るようにする',
      '🔐その他のバグ修正'
    ]},
    { version:'2.0.0', date:'2026-09', items:[
      '⏱ タイムアタックモードを追加(制限時間60秒、専用ハイスコア・別ランキング)',
      '🔥 コンボ倍率システムを追加(連続ライン消去でスコア倍率アップ)',
      '🧱 テトリスにHOLD機能・WASD操作・操作説明パネルを追加',
      '🏠 メインメニュー画面を新設。記録・実績、設定ページを追加',
      '🔊 サウンドを一新(より満足感のあるサウンドに)',
      '🐞 テトリスのハードドロップがiPad横画面で見えない不具合を修正'
    ]}
  ];
  function renderChangelogHTML(){
    const latest = CHANGELOG[0];
    return `<h4>📢 更新履歴（最新）</h4>
      <div class="cl-entry"><b>Ver ${latest.version}（${latest.date}）</b>${latest.items.map(i=>`・${i}`).join('<br>')}</div>
      <button id="viewFullHistoryBtn" style="width:100%; margin-top:8px; background:var(--panel-light); border:none; color:var(--mint); font-weight:800; font-size:11.5px; padding:8px 0; border-radius:10px; cursor:pointer;">📜 過去の更新履歴を見る</button>
    `;
  }
  function renderFullHistoryModal(){
    modalContent.dataset.mode = 'history';
    let html = `<h2 style="color:var(--gold);">📜 過去の更新履歴</h2>`;
    CHANGELOG.forEach(v=>{
      html += `<div class="quest-item"><div class="qtitle">Ver ${v.version}（${v.date}）</div>
        <div class="sub" style="margin-top:4px;">${v.items.map(i=>`・${i}`).join('<br>')}</div></div>`;
    });
    modalContent.innerHTML = html;
  }
  const changelogPanelEl = document.getElementById('changelogPanel');
  function openChangelogPanel(){
    changelogPanelEl.innerHTML = renderChangelogHTML();
    const btn = document.getElementById('viewFullHistoryBtn');
    if(btn) btn.addEventListener('click', ()=>{
      changelogPanelEl.classList.remove('show');
      renderFullHistoryModal();
      modalOverlay.classList.add('show');
    });
  }
  document.getElementById('versionBadge').addEventListener('click', ()=>{
    if(changelogPanelEl.classList.contains('show')){ changelogPanelEl.classList.remove('show'); return; }
    openChangelogPanel();
    changelogPanelEl.classList.add('show');
  });
  document.getElementById('titleChangelogBtn').addEventListener('click', ()=>{
    openChangelogPanel();
    changelogPanelEl.classList.add('show');
  });

  // ===================== 🆕 スケジュールイベント(管理者が設定した自動報酬)のカウントダウン表示 =====================
  let eventsData = [];
  const eventCountdownBadgeEl = document.getElementById('eventCountdownBadge');
  const eventCountdownTextEl = document.getElementById('eventCountdownText');

  async function fetchEventsList(){
    try{
      const r = await fetch(`${API_BASE_URL}/api/events/list`);
      const data = await r.json();
      eventsData = data.events || [];
      updateEventCountdownBadge();
    }catch(err){ /* 無視 */ }
  }

  function formatHMS(totalSec){
    const sec = Math.max(0, Math.round(totalSec));
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function updateEventCountdownBadge(){
    if(!eventsData.length){ eventCountdownBadgeEl.style.display = 'none'; return; }
    const soonest = eventsData.reduce((a,b)=> a.secondsUntilNext<b.secondsUntilNext ? a : b);
    eventCountdownBadgeEl.style.display = 'block';
    eventCountdownTextEl.textContent = `⏰ ${formatHMS(soonest.secondsUntilNext)}`;
  }

  function tickEventCountdown(){
    if(!eventsData.length) return;
    eventsData.forEach(ev=>{ ev.secondsUntilNext = Math.max(0, ev.secondsUntilNext-1); });
    updateEventCountdownBadge();
    if(modalOverlay.classList.contains('show') && modalContent.dataset.mode==='events') renderEventsModal();
  }

  function eventWhenLabel(ev){
    const t = `${String(ev.hourJst).padStart(2,'0')}:${String(ev.minuteJst||0).padStart(2,'0')}`;
    if(ev.recurrence==='once') return `${ev.eventYear}/${ev.eventMonth}/${ev.eventDay} ${t} に一度だけ`;
    if(ev.recurrence==='weekly') return `毎週${['日','月','火','水','木','金','土'][ev.eventDay]}曜 ${t}`;
    if(ev.recurrence==='monthly') return `毎月${ev.eventDay}日 ${t}`;
    return `毎日 ${t}`;
  }

  function renderEventsModal(){
    modalContent.dataset.mode = 'events';
    let html = `<h2 style="color:var(--gold);">🎉 イベント一覧</h2>
      <div class="sub" style="margin-bottom:10px;">指定した日時(日本時間)になると、対象ランキングの順位者へ自動でコインが配布されます。</div>`;
    if(eventsData.length===0){
      html += `<div class="empty-hint">現在開催中のイベントはありません。</div>`;
    } else {
      eventsData.slice().sort((a,b)=>a.secondsUntilNext-b.secondsUntilNext).forEach(ev=>{
        const modeLabel = RANKING_MODE_LABELS[ev.rankingMode] || ev.rankingMode;
        html += `
          <div class="quest-item">
            <div class="qtitle">${modeLabel}ランキング ${ev.rankPosition}位 → 🪙${formatNumber(ev.rewardCoins)}</div>
            <div class="sub">${eventWhenLabel(ev)}(日本時間)に自動配布</div>
            <div class="sub" style="color:var(--mint); font-weight:800; margin-top:4px;">次回まで: ${formatHMS(ev.secondsUntilNext)}</div>
          </div>`;
      });
    }
    modalContent.innerHTML = html;
  }

  eventCountdownBadgeEl.addEventListener('click', ()=>{
    renderEventsModal();
    modalOverlay.classList.add('show');
  });

  // ===================== 初期化 =====================
  (async function start(){
    await loadCustomBackground();
    await loadAppSettings();
    await loadBest();
    await loadBestScores();  // モード別ベスト読み込み
    await loadCoins();
    await loadSkinsData();
    await loadSettings();
    await loadDailyQuests();
    // リロード後も安全にログイン状態を復元(トークンをサーバーで検証してから復元)
    await restoreSession();
    updateAccountButton();
    updateModeBadge();
    if(currentMode === 'tetris'){
      enterTetrisMode();
    } else {
      initBoard();
      fillTray();
    }
    // 外部サイトへは飛ばさず、まずアプリ内のメインメニュー画面を表示する
    showTitleScreen();
    // お知らせ・アップデート確認(ログイン状態に関わらず定期チェック)
    await loadLastSeenAnnouncement();
    checkAnnouncements();
    setInterval(checkAnnouncements, 20000);
    setInterval(checkForUpdate, 60000);
    // イベントカウントダウン(1秒ごとに更新、1分ごとにサーバーと再同期)
    await fetchEventsList();
    setInterval(tickEventCountdown, 1000);
    setInterval(fetchEventsList, 5000); // 短めの間隔にして、管理者がイベントを削除した際も全員の画面にすぐ反映されるようにする
  })();

})();
