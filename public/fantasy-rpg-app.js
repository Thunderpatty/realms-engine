
    let gameData = { races: [], classes: [] };
    let state = null;
    let selectedRace = null;
    let selectedClass = null;
    let lastMessages = [];
    let lastCombatLog = [];
    let storyView = 'menu'; // 'menu' | 'market' | 'home' | 'classTrainer'
    let combatTargetId = null;
    let classTrainerData = null;
    let classTrainerTab = 'abilities'; // 'abilities' | 'quests' | 'spec'
    let homeInvSelected = null;
    const GAME_CONFIG_COMP_ICONS = { wolf: '🐺', hawk: '🦅', bear: '🐻', serpent: '🐍' };
    let homeRecipeFilter = 'all';
    let homeTab = 'crafting';
    let selectedRecipeSlug = null;
    let craftQty = 1;
    let academyLoadoutMode = 'pve'; // 'pve' | 'pvp' | 'raid'
    let _lastSeenLogId = null; // Track newest log entry ID for toast detection

    // ══════════════════════════════════════════
    //  AUDIO ENGINE — realm-based music system
    // ══════════════════════════════════════════
    const MUSIC_TRACKS = {
      // Login / character creation
      'login':      '/assets/music/login.mp3',
      // Ambient tracks (one per realm — plays everywhere in that realm)
      'ashlands':   '/assets/music/ashlands.mp3',
      'frostreach': '/assets/music/frostreach.mp3',
      'emberveil':  '/assets/music/emberveil.mp3',
      'voidspire':  '/assets/music/voidspire.mp3',
      // Combat tracks (one per realm + raid boss)
      'combat-ashlands':   '/assets/music/combat-ashlands.mp3',
      'combat-frostreach': '/assets/music/combat-frostreach.mp3',
      'combat-emberveil':  '/assets/music/combat-emberveil.mp3',
      'combat-voidspire':  '/assets/music/combat-voidspire.mp3',
      'combat-raidboss':   '/assets/music/combat-raidboss.mp3',
    };

    const _audio = {
      current: null,       // currently playing Audio element
      currentTrack: null,  // track key currently playing
      volume: 0.3,         // master volume (0-1)
      muted: false,
      fadeMs: 1500,         // crossfade duration
      cache: {},            // preloaded Audio elements
      enabled: true,
      unlocked: false,      // needs user interaction to unlock Web Audio
    };

    function audioGetOrCreate(trackKey) {
      if (_audio.cache[trackKey]) return _audio.cache[trackKey];
      const src = MUSIC_TRACKS[trackKey];
      if (!src) return null;
      const a = new Audio(src);
      a.loop = true;
      a.volume = 0;
      a.addEventListener('error', () => { delete _audio.cache[trackKey]; });
      _audio.cache[trackKey] = a;
      return a;
    }

    function audioUnlock() {
      if (_audio.unlocked) return;
      _audio.unlocked = true;
      // After unlock, try to play the desired track
      audioUpdateTrack();
    }

    function audioFadeTo(trackKey) {
      if (!_audio.enabled || _audio.muted || !_audio.unlocked) return;
      if (trackKey === _audio.currentTrack) return;
      const newAudio = audioGetOrCreate(trackKey);
      if (!newAudio) return;

      const oldAudio = _audio.current;
      _audio.currentTrack = trackKey;
      _audio.current = newAudio;

      // Fade out old
      if (oldAudio) {
        const fadeOut = oldAudio;
        const startVol = fadeOut.volume;
        const steps = 20;
        const stepMs = _audio.fadeMs / steps;
        let step = 0;
        const fadeOutInterval = setInterval(() => {
          step++;
          fadeOut.volume = Math.max(0, startVol * (1 - step / steps));
          if (step >= steps) {
            clearInterval(fadeOutInterval);
            fadeOut.pause();
            fadeOut.volume = 0;
          }
        }, stepMs);
      }

      // Fade in new
      newAudio.volume = 0;
      newAudio.play().then(() => {
        const targetVol = _audio.volume;
        const steps = 20;
        const stepMs = _audio.fadeMs / steps;
        let step = 0;
        const fadeInInterval = setInterval(() => {
          step++;
          newAudio.volume = Math.min(targetVol, targetVol * (step / steps));
          if (step >= steps) clearInterval(fadeInInterval);
        }, stepMs);
      }).catch(() => {
        // Autoplay blocked — clear track so next unlock retries
        _audio.currentTrack = null;
        _audio.current = null;
      });
    }

    function audioSetVolume(vol) {
      _audio.volume = Math.max(0, Math.min(1, vol));
      if (_audio.current && !_audio.muted) _audio.current.volume = _audio.volume;
      localStorage.setItem('musicVolume', _audio.volume);
    }

    function audioToggleMute() {
      _audio.muted = !_audio.muted;
      if (_audio.muted) {
        if (_audio.current) { _audio.current.pause(); _audio.current.volume = 0; }
        _audio.currentTrack = null;
        _audio.current = null;
      } else {
        audioUpdateTrack();
      }
      localStorage.setItem('musicMuted', _audio.muted ? '1' : '0');
    }

    function audioGetDesiredTrack() {
      if (!state?.character) return 'login';
      const c = state.character;
      const realm = state.currentRealm || 'ashlands';

      // Raid boss combat
      if (partyCombatData && partyCombatData.isBossRoom) return 'combat-raidboss';
      // Party combat (raid)
      if (partyCombatData && partyCombatData.phase && partyCombatData.phase !== 'victory' && partyCombatData.phase !== 'wipe') {
        return 'combat-' + realm;
      }
      // Solo combat
      if (c.in_combat) return 'combat-' + realm;
      // Realm ambient
      return realm;
    }

    function audioUpdateTrack() {
      if (!_audio.enabled || _audio.muted) return;
      const desired = audioGetDesiredTrack();
      if (desired && desired !== _audio.currentTrack) {
        audioFadeTo(desired);
      }
    }

    function audioInit() {
      const savedVol = localStorage.getItem('musicVolume');
      if (savedVol !== null) _audio.volume = parseFloat(savedVol);
      _audio.muted = localStorage.getItem('musicMuted') === '1';
    }

    // Quest presentation state
    let questMode = null; // { slug, showChoices: bool, outcome: null | { messages, rollInfo, success } }
    let pendingQuestComplete = null; // { title, messages } for completion overlay

    const activeTabs = { left: 'charTab' };
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    const EQUIP_SLOTS = ['weapon', 'shield', 'body', 'helmet', 'gloves', 'boots', 'amulet', 'ring', 'trinket'];
    function isRaidTown(loc) { return (gameData?.realms || []).some(r => r.raidTown === loc); }
    const _rankCostMul = [1.0, 1.1, 1.2, 1.4, 1.7];
    const _rankCostFloor = [0, 1, 1, 3, 4];
    function getAbilityRankCost(base, rank) { const i = Math.max(0, Math.min(4, rank-1)); return Math.max(Math.floor(base*_rankCostMul[i]), base+_rankCostFloor[i]); }

    // Asset image helpers — graceful fallback if image doesn't exist
    const _assetCache = {}; // slug -> true/false/pending
    function enemyImageUrl(slug) { return `/assets/enemies/${slug}.png`; }
    function locationImageUrl(slug) { return `/assets/locations/${slug}.png`; }
    function allyImageUrl(type) {
      // Map companion types and player class to portrait images
      // Falls back to placeholder
      const map = { wolf: 'companion-placeholder', hawk: 'companion-placeholder', bear: 'companion-placeholder', serpent: 'companion-placeholder' };
      return `/assets/enemies/${map[type] || 'player-placeholder'}.png`;
    }
    function playerImageUrl() { return `/assets/enemies/player-placeholder.png`; }
    function renderEnemyPortrait(slug, opts = {}) {
      const dead = opts.dead || false;
      return `<div class="enemy-portrait${dead ? ' enemy-portrait-dead' : ''}">
        <img src="${enemyImageUrl(slug)}" alt="" style="width:100%;height:auto;display:block;border-radius:10px" onerror="this.parentElement.style.display='none'">
      </div>`;
    }
    function renderLocationBanner(slug) {
      return `<div class="location-banner">
        <img src="${locationImageUrl(slug)}" alt="" onerror="this.parentElement.style.display='none'">
        <div class="location-banner-fade"></div>
      </div>`;
    }

    function getItemEquipSlot(item = {}) {
      return item.type || null;
    }

    function getEquippedItemFor(item = {}) {
      const slot = getItemEquipSlot(item);
      if (!EQUIP_SLOTS.includes(slot)) return null;
      return state?.equipment?.[slot] || null;
    }

    function compareItemStatClass(value, equippedValue) {
      if (value > equippedValue) return 'gear-better';
      if (value === equippedValue) return 'gear-same';
      return 'gear-worse';
    }

    function renderStatSummary(stats = {}, options = {}) {
      const labels = { attack: 'ATK', defense: 'DEF', str: 'STR', dex: 'DEX', int: 'INT', wis: 'WIS', con: 'CON', cha: 'CHA' };
      const compareStats = options.compareStats || null;
      // Merge all stat keys from both items so we show losses too
      const allKeys = new Set([...Object.keys(stats), ...(compareStats ? Object.keys(compareStats) : [])]);
      const entries = [...allKeys]
        .filter(key => labels[key])
        .filter(key => (stats[key] || 0) !== 0 || (compareStats && (compareStats[key] || 0) !== 0))
        .sort((a, b) => {
          const order = ['attack','defense','str','dex','int','wis','con','cha'];
          return order.indexOf(a) - order.indexOf(b);
        });
      if (!entries.length) return '';
      return `<div class="mono stat-summary">${entries.map(key => {
        const value = stats[key] || 0;
        const eqValue = compareStats ? Number(compareStats[key] || 0) : 0;
        const cls = compareStats ? compareItemStatClass(value, eqValue) : '';
        if (value === 0 && compareStats) {
          // Stat exists on equipped but not on this item — show the loss
          return `<span class="gear-worse">${labels[key]} +0 <span style="font-size:.7rem">(−${eqValue})</span></span>`;
        }
        const primaryHighlight = options.myPrimary && key === options.myPrimary && value > 0 ? ' style="color:var(--gold);font-weight:600"' : '';
        return `<span class="${cls}"${primaryHighlight}>${labels[key]} ${value > 0 ? '+' : ''}${value}</span>`;
      }).join('<span class="muted">·</span>')}</div>`;
    }

    function renderRarityName(item, fallback) {
      const name = item?.name || fallback || 'Unknown';
      const rarity = item?.rarity || 'common';
      return `<span class="rarity-${esc(rarity)}">${esc(name)}</span>`;
    }

    function renderStatusEffects(effects = [], label = '') {
      if (!effects.length) return '';
      return `<div class="status-effects">${label ? `<span class="muted" style="font-size:.7rem;margin-right:2px">${esc(label)}</span>` : ''}${effects.map(e => {
        const meta = [];
        if (e.source) meta.push(`Source: ${esc(e.source)}`);
        meta.push(`${e.turnsLeft} turn${e.turnsLeft !== 1 ? 's' : ''} remaining`);
        if (e.damagePerTurn) meta.push(`${e.damagePerTurn} damage/turn`);
        if (e.healPerTurn) meta.push(`${e.healPerTurn} heal/turn`);
        if (e.statMod) meta.push(Object.entries(e.statMod).map(([k,v]) => `${v > 0 ? '+' : ''}${v} ${k.toUpperCase()}`).join(', '));
        return `<span class="tt-wrap"><span class="status-pill ${esc(e.type || 'debuff')}">${esc(e.icon || '✦')} ${esc(e.name)} ${e.turnsLeft}</span><span class="tt"><div class="tt-title">${esc(e.icon || '✦')} ${esc(e.name)}</div><span class="tt-tag ${esc(e.type || 'debuff')}">${esc(e.type || 'effect')}</span>${e.description ? `<div class="tt-desc" style="margin-top:6px">${esc(e.description)}</div>` : ''}<div class="tt-meta">${meta.join('<br>')}</div></span></span>`;
      }).join('')}</div>`;
    }

    function renderAbilityButton(a, forceDisabled, cdLabel, btnStyle) {
      const meta = [];
      if (a.type === 'physical' || a.type === 'magic') {
        meta.push(`<span class="tt-tag ${esc(a.type)}">${esc(a.type)}</span>`);
        if (a.damage) meta.push(`<span class="tt-tag ${esc(a.type)}">${a.hits ? a.hits + '×' : ''}${a.damage}x dmg</span>`);
      } else {
        meta.push(`<span class="tt-tag ${esc(a.type)}">${esc(a.type)}</span>`);
      }
      if (a.stun) meta.push(`<span class="tt-tag stun">stun</span>`);
      if (a.slow) meta.push(`<span class="tt-tag slow">slow</span>`);
      if (a.dot) meta.push(`<span class="tt-tag dot">${a.dot.damage} ${a.dot.type || 'poison'}/turn ×${a.dot.turns}t</span>`);
      if (a.statusEffect) meta.push(`<span class="tt-tag debuff">${esc(a.statusEffect.slug)} ${a.statusEffect.turns}t</span>`);
      if (a.healPct) meta.push(`<span class="tt-tag heal">heal ${a.healPct}% HP</span>`);
      if (a.heal) meta.push(`<span class="tt-tag heal">heal ${a.heal} HP</span>`);
      if (a.selfDamagePct) meta.push(`<span class="tt-tag dot">self −${a.selfDamagePct}% HP</span>`);
      if (a.restore) meta.push(`<span class="tt-tag restore">+${a.restore} MP</span>`);
      if (a.restoreMp) meta.push(`<span class="tt-tag restore">+${a.restoreMp} MP</span>`);
      if (a.buff) {
        const bLabel = a.buff.stat === 'all' ? `+${a.buff.amount} all stats` : a.buff.stat === 'dodge' ? `${a.buff.amount}% dodge` : `+${a.buff.amount} ${a.buff.stat.toUpperCase()}`;
        meta.push(`<span class="tt-tag buff">${esc(bLabel)} ${a.buff.turns}t</span>`);
      }
      if (a.secondaryBuff) {
        const bLabel = `+${a.secondaryBuff.amount} ${a.secondaryBuff.stat.toUpperCase()}`;
        meta.push(`<span class="tt-tag buff">${esc(bLabel)} ${a.secondaryBuff.turns}t</span>`);
      }
      const abilTypeClass = 'btn-ability-' + (a.type || 'physical');
      const rank = (state?.character?.ability_ranks || {})[a.slug] || 1;
      const rankLabel = rank > 1 ? ` R${rank}` : '';
      const ultClass = a.ultimate ? ' btn-ultimate' : '';
      return `<span class="tt-wrap"><button class="${abilTypeClass}${ultClass} small" data-action="combatAction" data-type="ability" data-ability="${a.slug}" ${forceDisabled?'disabled':''} ${btnStyle||''}>${esc(a.name)}${rankLabel} (${getAbilityRankCost(a.cost, rank)} MP)${cdLabel||''}</button><span class="tt"><div class="tt-title">${esc(a.name)}${rankLabel}</div><div class="tt-cost">${getAbilityRankCost(a.cost, rank)} MP${rank > 1 ? ' · Rank ' + rank : ''}</div><div class="tt-desc">${esc(a.description || '')}</div><div class="tt-meta">${meta.join(' ')}</div></span></span>`;
    }

    function renderItemEffectSummary(item = {}) {
      const parts = [];
      if (item.use?.heal) parts.push(`Heals ${item.use.heal} HP`);
      if (item.use?.mana) parts.push(`Restores ${item.use.mana} MP`);
      if (item.use?.cure) parts.push(`Cures ${String(item.use.cure).toUpperCase()}`);
      if (item.use?.combatOnly) parts.push('Combat use only');
      if (Array.isArray(item.use?.effects)) {
        item.use.effects.forEach(effect => parts.push(`Grants ${String(effect.slug || '').toUpperCase()} for ${effect.turns || 1} turn${(effect.turns || 1) === 1 ? '' : 's'}`));
      }
      if (Array.isArray(item.use?.tempPassives)) {
        item.use.tempPassives.forEach(passive => {
          if (passive.lifestealPct) parts.push(`${passive.lifestealPct}% lifesteal for ${passive.turns || 1} turns`);
          if (passive.manaRegen) parts.push(`${passive.manaRegen} MP/turn for ${passive.turns || 1} turns`);
          if (passive.hpRegen) parts.push(`${passive.hpRegen} HP/turn for ${passive.turns || 1} turns`);
          if (passive.onHitStatus) {
            const status = passive.onHitStatus;
            parts.push(`${status.chance || 100}% to inflict ${String(status.slug || '').toUpperCase()} for ${status.turns || 1} turn${(status.turns || 1) === 1 ? '' : 's'} (${passive.turns || 1} turns)`);
          }
        });
      }
      if (item.passive?.lifestealPct) parts.push(`${item.passive.lifestealPct}% lifesteal`);
      if (item.passive?.manaRegen) parts.push(`Restores ${item.passive.manaRegen} MP/turn`);
      if (item.passive?.hpRegen) parts.push(`Restores ${item.passive.hpRegen} HP/turn`);
      if (item.passive?.onHitStatus) {
        const status = item.passive.onHitStatus;
        parts.push(`${status.chance || 100}% to inflict ${String(status.slug || '').toUpperCase()} for ${status.turns || 1} turn${(status.turns || 1) === 1 ? '' : 's'}`);
      }
      if (!parts.length) return '';
      return `<div class="mono" style="margin-top:8px;color:var(--emerald);font-size:.8rem">${parts.map(esc).join(' · ')}</div>`;
    }

    function renderPerks(perks) {
      if (!perks || !perks.length) return '';
      const lines = perks.map(p => {
        if (p.type === 'stat') return `<div class="perk-line perk-stat">⚡ +${p.value} ${(p.stat||'').toUpperCase()}</div>`;
        if (p.type === 'lifesteal') return `<div class="perk-line perk-lifesteal">🩸 ${p.value}% Lifesteal</div>`;
        if (p.type === 'critBonus') return `<div class="perk-line perk-crit">🎯 +${p.value}% Crit Chance</div>`;
        if (p.type === 'dodgeBonus') return `<div class="perk-line perk-dodge">💨 +${p.value}% Dodge</div>`;
        if (p.type === 'hpRegen') return `<div class="perk-line perk-regen">💚 +${p.value} HP/turn</div>`;
        if (p.type === 'manaRegen') return `<div class="perk-line perk-regen">💜 +${p.value} MP/turn</div>`;
        if (p.type === 'onHitStatus') return `<div class="perk-line perk-onhit">🔥 ${p.chance}% ${(p.slug||'').toUpperCase()} on hit (${p.turns}t)</div>`;
        return '';
      });
      return `<div class="perk-list">${lines.join('')}</div>`;
    }

    function renderEquipSlot(item = {}) {
      const slot = getItemEquipSlot(item);
      if (!EQUIP_SLOTS.includes(slot)) return '';
      const equipped = getEquippedItemFor(item);
      return `<div class="mono muted" style="margin-top:8px;font-size:.76rem">Equip Slot: ${esc(String(slot).toUpperCase())}</div>
        <div class="mono muted compare-hint">Equipped: ${equipped ? renderRarityName(equipped) : 'Empty'}</div>`;
    }

    function switchTab(group, tabId) {
      activeTabs[group] = tabId;
      const panel = $('leftPanel');
      panel.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
      panel.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === tabId));
    }

    function appConfirm(message, confirmLabel = 'Confirm', cancelLabel = 'Cancel') {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        const cleanup = (result) => { overlay.remove(); resolve(result); };
        overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
        overlay.innerHTML = `
          <div class="confirm-dialog">
            <div class="confirm-msg">${esc(message)}</div>
            <div class="confirm-buttons">
              <button class="confirm-no" id="confirmNo">${cancelLabel}</button>
              <button class="confirm-yes" id="confirmYes">${confirmLabel}</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#confirmNo').onclick = () => cleanup(false);
        overlay.querySelector('#confirmYes').onclick = () => cleanup(true);
        overlay.querySelector('#confirmYes').focus();
      });
    }

    function showMessage(text, isError = false) {
      if (!text) return;
      showToast(isError ? 'error' : 'info', isError ? 'Error' : '', text);
    }

    // ── Loading state + connection error handling ──
    let _loading = false;
    let _lastClickedEl = null;

    function setLoading(active, clickedEl = null) {
      _loading = active;
      _lastClickedEl = active ? clickedEl : null;
      // Disable/enable all action buttons
      document.querySelectorAll('[data-action]').forEach(el => {
        if (active) {
          el.setAttribute('data-was-disabled', el.disabled ? '1' : '0');
          el.disabled = true;
        } else {
          // Restore: if data-was-disabled exists, use it; otherwise enable
          const was = el.getAttribute('data-was-disabled');
          el.disabled = was === '1';
          el.removeAttribute('data-was-disabled');
        }
      });
      // Show spinner on clicked button (skip status bar buttons — they're static HTML)
      if (active && clickedEl && !clickedEl.closest('.status-bar') && !clickedEl.closest('.topbar')) {
        clickedEl._origText = clickedEl.innerHTML;
        clickedEl.innerHTML = '<span class="loading-dots">···</span>';
      } else if (!active && clickedEl?._origText) {
        clickedEl.innerHTML = clickedEl._origText;
        delete clickedEl._origText;
      }
    }

    // Safety net: ensure loading state is cleared after any render cycle
    function ensureLoadingCleared() {
      if (_loading) {
        console.warn('Loading state was stuck — forcibly clearing');
        _loading = false;
      }
      // Force-enable ALL disabled action buttons and clean up stale attributes
      document.querySelectorAll('[data-action]').forEach(el => {
        el.disabled = false;
        el.removeAttribute('data-was-disabled');
      });
    }

    function showConnectionBanner(msg) {
      let banner = document.getElementById('connBanner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'connBanner';
        banner.className = 'conn-banner';
        document.body.prepend(banner);
      }
      banner.textContent = msg;
      banner.classList.remove('hidden');
    }
    function hideConnectionBanner() {
      const banner = document.getElementById('connBanner');
      if (banner) banner.classList.add('hidden');
    }

    async function api(url, options = {}) {
      const res = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      hideConnectionBanner();
      return data;
    }

    async function post(url, body = {}) {
      if (_loading) return; // Debounce — ignore while a request is in-flight
      const clickedEl = _lastClickedEl || document.activeElement;
      setLoading(true, clickedEl);
      try {
        try {
          return await api(url, { method: 'POST', body: JSON.stringify(body) });
        } catch (err) {
          // Retry once on network/server error (not 4xx client errors)
          if (err.message === 'Request failed' || err.message === 'Failed to fetch' || err.message.includes('NetworkError')) {
            showConnectionBanner('Connection issue — retrying...');
            await new Promise(r => setTimeout(r, 2000));
            try {
              const result = await api(url, { method: 'POST', body: JSON.stringify(body) });
              hideConnectionBanner();
              return result;
            } catch (retryErr) {
              showConnectionBanner('Connection lost. Check your internet and refresh.');
              throw retryErr;
            }
          }
          throw err;
        }
      } finally {
        setLoading(false, clickedEl);
      }
    }

    // ── Location helpers ──
    const locIcon = (type) => ({ town: '🏘', wild: '⚔', dungeon: '🏰', portal: '🌀' }[type] || '📍');
    const locTypeClass = (type) => ({ town: 'nav-type-town', wild: 'nav-type-wild', dungeon: 'nav-type-dungeon' }[type] || '');

    // ── Graph Layout Engine ──
    // Computes (x, y) positions for nodes from the connection graph using force-directed simulation.
    // Returns Map<slug, {x, y}> with values in [padding, 100-padding] percent space.
    const _layoutCache = new Map(); // realm slug → Map<slug, {x,y}>

    function computeGraphLayout(locations, portalNodes, opts = {}) {
      // portalNodes: [{slug, name, connectsTo}] — virtual nodes for realm exits
      const allNodes = [...locations, ...portalNodes];
      const slugs = allNodes.map(l => l.slug);
      const n = slugs.length;
      if (n === 0) return new Map();

      const idx = {};
      slugs.forEach((s, i) => idx[s] = i);

      // Adjacency
      const adj = slugs.map(() => []);
      for (const l of allNodes) {
        const i = idx[l.slug];
        for (const c of (l.connections || [])) {
          const j = idx[c];
          if (j !== undefined) {
            if (!adj[i].includes(j)) adj[i].push(j);
            if (!adj[j].includes(i)) adj[j].push(i);
          }
        }
      }

      // Initialize positions — towns/hubs spread first, others random
      // Use deterministic seed based on slug names for stable layouts
      let _seed = 0;
      for (const s of slugs) for (let i = 0; i < s.length; i++) _seed = (_seed * 31 + s.charCodeAt(i)) & 0x7fffffff;
      const seededRand = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return (_seed / 0x7fffffff); };

      const px = new Float64Array(n);
      const py = new Float64Array(n);
      const towns = [];
      const others = [];
      allNodes.forEach((l, i) => {
        if (l.type === 'town') towns.push(i);
        else others.push(i);
      });

      // Place towns evenly spread
      const cx = 50, cy = 50;
      if (towns.length === 1) {
        px[towns[0]] = cx; py[towns[0]] = cy;
      } else {
        towns.forEach((ti, k) => {
          const angle = (k / towns.length) * Math.PI * 2 - Math.PI / 2;
          px[ti] = cx + Math.cos(angle) * 30;
          py[ti] = cy + Math.sin(angle) * 30;
        });
      }
      // Others: place near their first connected town, or seeded random
      for (const i of others) {
        const connTown = adj[i].find(j => allNodes[j].type === 'town');
        if (connTown !== undefined) {
          px[i] = px[connTown] + (seededRand() - 0.5) * 24;
          py[i] = py[connTown] + (seededRand() - 0.5) * 24;
        } else {
          px[i] = 15 + seededRand() * 70;
          py[i] = 15 + seededRand() * 70;
        }
      }

      // Force-directed: iterate
      const ITERS = 300;
      const REPULSION = opts.repulsion || 800;
      const SPRING = 0.05;
      const IDEAL_LEN = opts.idealLen || 22;
      const DAMPING = 0.9;
      const MIN_DIST = opts.minDist || 12; // post-process minimum distance
      const vx = new Float64Array(n);
      const vy = new Float64Array(n);

      for (let iter = 0; iter < ITERS; iter++) {
        const temp = 1 - iter / ITERS; // cooling
        // Repulsion (all pairs)
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            let dx = px[i] - px[j];
            let dy = py[i] - py[j];
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) { dx = 0.5 + seededRand() * 0.5; dy = 0.5 + seededRand() * 0.5; d2 = 1; }
            const f = REPULSION / d2 * temp;
            vx[i] += dx * f; vy[i] += dy * f;
            vx[j] -= dx * f; vy[j] -= dy * f;
          }
        }
        // Spring attraction (edges)
        for (let i = 0; i < n; i++) {
          for (const j of adj[i]) {
            if (j <= i) continue;
            const dx = px[j] - px[i];
            const dy = py[j] - py[i];
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const f = (d - IDEAL_LEN) * SPRING * temp;
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            vx[i] += fx; vy[i] += fy;
            vx[j] -= fx; vy[j] -= fy;
          }
        }
        // Gravity toward center
        for (let i = 0; i < n; i++) {
          vx[i] += (cx - px[i]) * 0.004 * temp;
          vy[i] += (cy - py[i]) * 0.004 * temp;
        }
        // Apply + damp
        for (let i = 0; i < n; i++) {
          vx[i] *= DAMPING; vy[i] *= DAMPING;
          px[i] += vx[i]; py[i] += vy[i];
        }
      }

      // Post-process: push apart any nodes closer than MIN_DIST
      for (let pass = 0; pass < 20; pass++) {
        let moved = false;
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            let dx = px[i] - px[j];
            let dy = py[i] - py[j];
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < MIN_DIST && d > 0.01) {
              const push = (MIN_DIST - d) / 2 + 0.5;
              const nx = dx / d, ny = dy / d;
              px[i] += nx * push; py[i] += ny * push;
              px[j] -= nx * push; py[j] -= ny * push;
              moved = true;
            } else if (d <= 0.01) {
              px[i] += seededRand() * 2; py[j] += seededRand() * 2;
              moved = true;
            }
          }
        }
        if (!moved) break;
      }

      // Normalize to [PAD, 100-PAD] percent with padding
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        if (px[i] < minX) minX = px[i]; if (px[i] > maxX) maxX = px[i];
        if (py[i] < minY) minY = py[i]; if (py[i] > maxY) maxY = py[i];
      }
      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;
      const PAD = opts.padding || 10;
      const result = new Map();
      for (let i = 0; i < n; i++) {
        result.set(slugs[i], {
          x: PAD + ((px[i] - minX) / rangeX) * (100 - PAD * 2),
          y: PAD + ((py[i] - minY) / rangeY) * (100 - PAD * 2),
        });
      }
      return result;
    }

    function getRealmLayout(realmSlug, locations, realms, unlockedRealms) {
      if (_layoutCache.has(realmSlug)) return _layoutCache.get(realmSlug);
      const realmLocs = locations.filter(l => (l.realm || 'ashlands') === realmSlug);

      // Build portal nodes for connections to other realms
      const portalNodes = [];
      for (const r of realms) {
        if (!unlockedRealms.includes(r.slug)) continue;
        // Portal FROM this realm to another
        if (r.portalFromRealm === realmSlug && r.portalFromLocation) {
          portalNodes.push({
            slug: `_portal_to_${r.slug}`,
            name: `→ ${r.name}`,
            type: 'portal',
            connections: [r.portalFromLocation],
            portalTarget: r.slug,
          });
        }
        // Portal INTO this realm from another
        if (r.slug === realmSlug && r.portalFromRealm && r.portalToLocation) {
          portalNodes.push({
            slug: `_portal_from_${r.portalFromRealm}`,
            name: `→ ${realms.find(x => x.slug === r.portalFromRealm)?.name || r.portalFromRealm}`,
            type: 'portal',
            connections: [r.portalToLocation],
            portalTarget: r.portalFromRealm,
          });
        }
      }

      const nodeCount = realmLocs.length + portalNodes.length;
      const layout = computeGraphLayout(realmLocs, portalNodes, {
        repulsion: 800 + nodeCount * 80, // more nodes → more spread
        idealLen: 20 + nodeCount * 0.8,
        minDist: 12 + nodeCount * 0.5,
        padding: 8,
      });
      _layoutCache.set(realmSlug, { positions: layout, portalNodes });
      return { positions: layout, portalNodes };
    }

    function invalidateLayoutCache() { _layoutCache.clear(); }

    // ══════════════════════════════════════════
    //  CREATE VIEW
    // ══════════════════════════════════════════
    function renderCreateView() {
      $('createView').classList.remove('hidden');
      $('gameView').classList.add('hidden');
      $('statusBar').classList.add('hidden');
      audioUpdateTrack();
      $('raceOptions').innerHTML = gameData.races.map(r => {
        const rp = gameData.racialPassives?.[r.slug];
        return `
        <div class="option ${selectedRace === r.slug ? 'active' : ''}" data-action="selectRace" data-slug="${r.slug}">
          <div class="item-head"><strong>${esc(r.name)}</strong><span class="mono muted" style="font-size:.75rem">${esc(r.slug)}</span></div>
          <div class="muted" style="margin-top:8px">${esc(r.description)}</div>
          <div class="mono muted" style="margin-top:8px;font-size:.8rem">${Object.entries(r.stats).map(([k,v]) => `${k.toUpperCase()} ${v >= 0 ? '+' : ''}${v}`).join(' \u00b7 ')}</div>
          ${rp ? `<div style="margin-top:6px;font-size:.78rem;color:var(--amber)"><strong>${rp.icon} ${esc(rp.name)}</strong> — ${esc(rp.description)}</div>` : ''}
        </div>`;
      }).join('');
      const CLASS_TAGS = { warrior:'⚔ Melee Tank', mage:'🔮 Spell Caster', rogue:'🗡 Stealth DPS', cleric:'✨ Healer / Support', ranger:'🏹 Ranged Hybrid' };
      $('classOptions').innerHTML = gameData.classes.map(c => {
        const starters = c.abilities.filter(a => a.starter !== false);
        const primary = { warrior:'STR', mage:'INT', rogue:'DEX', cleric:'WIS', ranger:'DEX/WIS' }[c.slug] || '';
        return `<div class="option ${selectedClass === c.slug ? 'active' : ''}" data-action="selectClass" data-slug="${c.slug}">
          <div class="item-head"><strong>${esc(c.name)}</strong><span class="mono muted" style="font-size:.75rem">${CLASS_TAGS[c.slug] || ''}</span></div>
          <div class="muted" style="margin-top:8px">${esc(c.description)}</div>
          <div class="mono muted" style="margin-top:8px;font-size:.78rem">Primary: ${primary} · HP ${c.baseHp} · MP ${c.baseMp} · ${starters.length} starter abilities</div>
        </div>`;
      }).join('');
      renderSelectionPreview();
    }

    function renderSelectionPreview() {
      const race = gameData.races.find(r => r.slug === selectedRace);
      const cls = gameData.classes.find(c => c.slug === selectedClass);
      const starters = cls ? cls.abilities.filter(a => a.starter !== false) : [];
      const academyAbils = cls ? cls.abilities.filter(a => a.starter === false || a.tokenCost) : [];
      // Combined stat bonuses
      const statHtml = race ? Object.entries(race.stats).map(([k,v]) =>
        `<span style="color:${v > 0 ? 'var(--emerald)' : v < 0 ? 'var(--red)' : 'var(--muted)'}">${k.toUpperCase()} ${v >= 0 ? '+' : ''}${v}</span>`
      ).join(' · ') : '';
      const rp = race ? gameData.racialPassives?.[race.slug] : null;
      $('selectionPreview').innerHTML = `
        <div class="eyebrow">PREVIEW</div>
        <h3>${race ? esc(race.name) : 'Choose a race'} ${cls ? '\u00b7 ' + esc(cls.name) : ''}</h3>
        ${statHtml ? `<div class="mono" style="font-size:.78rem;margin-top:4px">${statHtml}</div>` : ''}
        ${rp ? `<div style="margin-top:6px;font-size:.82rem;color:var(--amber)"><strong>${rp.icon} ${esc(rp.name)}</strong> \u2014 ${esc(rp.description)}</div>` : ''}
        <div class="cards">
          <div class="item"><strong>Starter Abilities</strong><div class="muted">${starters.length ? starters.map(a => esc(a.name)).join(', ') : 'Pick a class to see abilities.'}</div>
            ${academyAbils.length ? `<div class="muted" style="margin-top:4px;font-size:.78rem;font-style:italic">+${academyAbils.length} more learnable at the Academy</div>` : ''}</div>
          <div class="item"><strong>Starter Kit</strong><div class="muted">3 Health Potions, a class weapon, 30 gold, and a room at Thornwall's edge.</div></div>
        </div>`;
    }

    function updateStatusBar() {
      const c = state.character;
      $('statusBar').classList.remove('hidden');
      $('sbName').textContent = c.name + (c.active_title ? ' ⟨' + c.active_title + '⟩' : '');
      $('sbHp').textContent = `${c.hp}/${c.max_hp}`;
      $('sbMp').textContent = `${c.mp}/${c.max_mp}`;
      $('sbGold').textContent = c.gold;
      $('sbLevel').textContent = c.level;
      $('sbHpBar').style.width = Math.max(0, Math.min(100, (c.hp / c.max_hp) * 100)) + '%';
      $('sbMpBar').style.width = Math.max(0, Math.min(100, (c.mp / c.max_mp) * 100)) + '%';
      // Context currencies — hide from status bar, show in relevant panels
      const gm = $('sbGuildMarks');
      const at = $('sbArcaneTokens');
      const ap = $('sbArenaPoints');
      const loc = $('sbLoc');
      if (gm) gm.parentElement.style.display = 'none';
      if (at) at.parentElement.style.display = 'none';
      if (ap) ap.parentElement.style.display = 'none';
      if (loc) loc.parentElement.style.display = 'none';
      // XP bar below status bar
      const xpPct = Math.max(0, Math.min(100, (c.xp / (state.xpNeeded || 1)) * 100));
      let xpBar = document.getElementById('sbXpBar');
      if (!xpBar) {
        xpBar = document.createElement('div');
        xpBar.id = 'sbXpBar';
        xpBar.style.cssText = 'height:3px;background:rgba(255,255,255,.05);width:100%;position:absolute;bottom:0;left:0;';
        xpBar.innerHTML = '<div class="fill xp" id="sbXpFill" style="height:100%;width:0%"></div>';
        $('statusBar').style.position = 'relative';
        $('statusBar').appendChild(xpBar);
      }
      const xpFill = document.getElementById('sbXpFill');
      if (xpFill) xpFill.style.width = xpPct + '%';
      // Music control in status bar
      let musicBtn = document.getElementById('sbMusic');
      if (!musicBtn) {
        musicBtn = document.createElement('div');
        musicBtn.id = 'sbMusic';
        musicBtn.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:auto;padding-left:8px;';
        $('statusBar').appendChild(musicBtn);
      }
      const volPct = Math.round(_audio.volume * 100);
      musicBtn.innerHTML = `
        <button class="small" data-action="musicToggle" style="padding:1px 6px;font-size:.65rem;background:none;border:1px solid var(--line);min-width:0;box-shadow:none;opacity:${_audio.muted ? '.4' : '1'}" title="${_audio.muted ? 'Unmute' : 'Mute'} music">${_audio.muted ? '🔇' : '🎵'}</button>
        <input type="range" id="musicVolumeSlider" min="0" max="100" value="${volPct}" style="width:60px;height:4px;accent-color:var(--gold);cursor:pointer;opacity:${_audio.muted ? '.3' : '.7'}" title="Volume ${volPct}%" ${_audio.muted ? 'disabled' : ''} />`;
      // Party indicator on social button
      const partyBtn = document.getElementById('sbPartyBtn');
      if (partyBtn) {
        const hasInvites = partyInvites && partyInvites.length > 0;
        const inParty = !!partyData;
        partyBtn.textContent = inParty ? '⚔' : '👥';
        partyBtn.title = inParty ? `Party (${partyData.members.length})` : 'Party & Friends';
        partyBtn.style.color = inParty ? '#14b8a6' : '';
        // Notification dot for invites
        let dot = partyBtn.querySelector('.invite-dot');
        if (hasInvites && !inParty) {
          if (!dot) { dot = document.createElement('span'); dot.className = 'invite-dot'; dot.style.cssText = 'position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:50%;background:#fbbf24;'; partyBtn.appendChild(dot); }
        } else if (dot) { dot.remove(); }
      }
    }

    // ══════════════════════════════════════════
    //  OUTCOME CLASSIFIER
    // ══════════════════════════════════════════
    function classifyOutcome(msg) {
      if (msg.includes('🏆') || msg.includes('Quest complete') || msg.includes('DUNGEON COMPLETE')) return 'om-complete';
      if (msg.includes('⬆') || msg.includes('LEVEL UP')) return 'om-reward';
      if (msg.includes('🛠') || msg.includes('🏠') || msg.includes('📜 Legendary recipe')) return 'om-reward';
      if (msg.includes('✓') || msg.includes('passed')) return 'om-success';
      if (msg.includes('⚠') || msg.includes('failed') || msg.includes('Failed') || msg.includes('damage')) return 'om-fail';
      if (msg.includes('📦') || msg.includes('Received') || msg.includes('Loot') || msg.includes('bonus') || msg.includes('🌿 Materials')) return 'om-reward';
      if (msg.includes('⚔') || msg.includes('appears') || msg.includes('Combat') || msg.includes('slain') || msg.includes('☠')) return 'om-combat';
      if (msg.includes('💰') || msg.includes('+')) return 'om-reward';
      return 'om-story';
    }

    // ══════════════════════════════════════════
    //  STORY PANEL — the unified center experience
    // ══════════════════════════════════════════
    function renderStoryPanel() {
      const c = state.character;
      const cls = gameData.classes.find(x => x.slug === c.class);
      const isDungeon = state.isDungeon;
      const ds = state.dungeonState;
      const gated = state.exploreGated;
      const hasEnemies = state.location?.type === 'wild' || state.location?.type === 'dungeon';
      let html = '';

      // ── COMBAT MODE ──
      if (c.in_combat && (c.combat_state?.enemies || c.combat_state?.enemy)) {

        const cs = c.combat_state;
        // Multi-entity support: read enemies[] or fall back to legacy enemy
        const enemies = cs.enemies || (cs.enemy ? [{ ...cs.enemy, id: 'e0', effects: cs.enemy.statusEffects || cs.enemyEffects || [] }] : []);
        const allies = cs.allies || [];
        const livingEnemies = enemies.filter(e => e.hp > 0);
        // Selected target: first living enemy by default
        if (!combatTargetId || !livingEnemies.find(e => e.id === combatTargetId)) {
          combatTargetId = livingEnemies[0]?.id || null;
        }
        const consumables = state.inventory.filter(i => i.type === 'consumable');
        const isBoss = cs.isBossRoom;
        const isArena = !!cs.arenaRun;
        const playerEffects = cs.playerEffects || [];
        const arenaAs = state.arenaState;
        const hasElite = enemies.some(e => e.elite && e.hp > 0);
        const isRaid = !!cs.raidRun;
        const combatEyebrow = isArena
          ? `🏟 ARENA — WAVE ${cs.arenaWave || arenaAs?.wave || '?'}${isBoss ? ' (ELITE)' : ''}`
          : isRaid ? (isBoss ? `🔥 RAID BOSS — FLOOR ${cs.raidFloor || '?'}` : `🕳 RAID COMBAT — FLOOR ${cs.raidFloor || '?'}`)
          : cs.dungeonRun ? (isBoss ? '🔥 BOSS ENCOUNTER' : '🏰 DUNGEON COMBAT') : (hasElite ? '⭐ ELITE COMBAT' : '⚔ COMBAT');
        html += `
          <div class="${isArena ? 'arena-box' : 'combat-box'}" style="position:relative">
            <div class="combat-bg"><img src="${locationImageUrl(c.location)}" alt="" onerror="this.parentElement.style.display='none'"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;position:relative">
              <div class="eyebrow">${combatEyebrow}</div>
              ${isArena && arenaAs ? `<div class="arena-ap-ticker">🏟 ${arenaAs.ap || 0} AP</div>` : ''}
            </div>`;
        // ── Render all enemies ──
        html += `<div class="enemy-gallery">`;
        for (const en of enemies) {
          const dead = en.hp <= 0;
          const isTarget = en.id === combatTargetId && !dead;
          const hpPct = Math.max(0, Math.min(100, (en.hp / en.maxHp) * 100));
          const targetClass = isTarget ? ' enemy-card-target' : '';
          const deadClass = dead ? ' enemy-card-dead' : '';
          const clickAttr = !dead && livingEnemies.length > 1 ? `data-action="setCombatTarget" data-id="${en.id}" style="cursor:pointer"` : '';
          html += `<div class="enemy-card${targetClass}${deadClass}" ${clickAttr}>
            <div class="enemy-card-name">${en.elite ? '⭐ ' : ''}${isBoss && en.boss ? '🔥 ' : ''}${esc(en.name)}${en.boss ? ' — BOSS' : ''}${en.elite && !en.boss ? ' — ELITE' : ''}${dead ? ' ☠' : ''}${isTarget ? ' ◄' : ''}</div>
            ${!dead ? renderEnemyPortrait(en.slug, { dead }) : ''}
            ${!dead ? `<div class="enemy-card-stats">ATK ${en.attack} · DEF ${en.defense} · HP ${en.hp}/${en.maxHp}</div>
            <div class="bar"><div class="fill hp" style="width:${hpPct}%"></div></div>
            ${renderStatusEffects(en.effects || [])}
            ${en.telegraphing ? `<div style="font-size:.72rem;color:#ff6b6b;font-weight:600;margin-top:3px;padding:3px 6px;border-radius:6px;background:rgba(255,60,60,.1);border:1px solid rgba(255,60,60,.2);animation:pulse 1s infinite">⚠ ${esc(en.telegraphing.name)} — ${en.telegraphing.turnsLeft}t</div>` : ''}
            ${en.enraged ? '<div style="font-size:.68rem;color:#ff4444;font-weight:700;margin-top:2px">🔥 ENRAGED</div>' : ''}` : ''}
          </div>`;
        }
        html += `</div>`;
        // ── Render player & allies gallery ──
        const playerHpPct = Math.max(0, Math.min(100, (c.hp / c.max_hp) * 100));
        const playerMpPct = Math.max(0, Math.min(100, (c.mp / c.max_mp) * 100));
        html += `<div class="ally-gallery">`;
        // Player card
        html += `<div class="ally-card">
          <div class="ally-card-name">${esc(c.name)}</div>
          <div class="ally-portrait"><img src="${playerImageUrl()}" alt="" onerror="this.parentElement.style.display='none'"></div>
          <div class="ally-card-stats">HP ${c.hp}/${c.max_hp}</div>
          <div class="bar" style="margin-top:2px"><div class="fill hp" style="width:${playerHpPct}%"></div></div>
          <div class="ally-card-stats">MP ${c.mp}/${c.max_mp}</div>
          <div class="bar" style="margin-top:2px"><div class="fill mp" style="width:${playerMpPct}%"></div></div>
        </div>`;
        // Ally cards (companions, party members)
        const livingAllies = allies.filter(a => a.hp > 0);
        for (const ally of livingAllies) {
          const allyHpPct = Math.max(0, Math.min(100, (ally.hp / ally.maxHp) * 100));
          const allyImg = ally.companionData && ally.type ? allyImageUrl(ally.type) : allyImageUrl('player');
          html += `<div class="ally-card">
            <div class="ally-card-name">${esc(ally.name)}</div>
            <div class="ally-portrait"><img src="${allyImg}" alt="" onerror="this.parentElement.style.display='none'"></div>
            <div class="ally-card-stats">HP ${ally.hp}/${ally.maxHp}</div>
            <div class="bar" style="margin-top:2px"><div class="fill hp" style="width:${allyHpPct}%"></div></div>`;
          // Pet ability selector for companions
          if (ally.companionData && ally.type && state.character?.companion) {
            const activeAb = ally.activeAbility;
            const cdMap = ally.cooldowns || {};
            const allCompAbils = classTrainerData?.companion?.abilities || [];
            if (allCompAbils.length > 0) {
              html += `<div style="margin-top:4px;display:flex;gap:2px;flex-wrap:wrap;justify-content:center">`;
              for (const ab of allCompAbils) {
                const isActive = ab.slug === activeAb;
                const onCd = cdMap[ab.slug] > 0;
                html += `<button class="${isActive ? '' : 'secondary'} small" style="font-size:.6rem;padding:2px 4px;${onCd ? 'opacity:.4' : ''}" data-action="setPetAbility" data-slug="${ab.slug}" ${onCd ? 'disabled' : ''}>${esc(ab.name)}${onCd ? ' [' + cdMap[ab.slug] + 't]' : ''}${isActive ? ' ◄' : ''}</button>`;
              }
              html += `</div>`;
            }
          }
          html += `</div>`;
        }
        html += `</div>`;
        html += `
            ${renderStatusEffects(playerEffects, 'ON YOU')}
            ${cs.dungeonMechanic ? `<div style="font-size:.75rem;color:rgba(255,160,60,.85);margin-top:6px;padding:4px 8px;border-radius:6px;background:rgba(255,160,60,.08);border:1px solid rgba(255,160,60,.15)">⚠ ${
              cs.dungeonMechanic === 'darkness' ? 'Darkness: -15% accuracy' :
              cs.dungeonMechanic === 'arcane-disruption' ? 'Arcane Disruption: MP costs +25%' :
              cs.dungeonMechanic === 'scorching-heat' ? 'Scorching Heat: 1% max HP/turn' :
              cs.dungeonMechanic === 'cursed-ground' ? 'Cursed Ground: 2% max HP per room' :
              cs.dungeonMechanic === 'cave-ins' ? 'Unstable Tunnels: risk of cave-ins' : cs.dungeonMechanic
            }</div>` : ''}
            ${livingEnemies.length > 1 ? '<div style="font-size:.72rem;color:var(--muted);margin-top:4px;font-style:italic">Click an enemy to change target</div>' : ''}
            ${(() => {
              const cb = state.character?.companion?.classBonus;
              if (!cb) return '';
              const def = gameData.classBonuses?.[cb];
              if (!def) return '';
              const parts = [];
              if (def.passive.damageMul > 1) parts.push(`+${Math.round((def.passive.damageMul - 1) * 100)}% DMG`);
              if (def.passive.damageTakenMul < 1) parts.push(`-${Math.round((1 - def.passive.damageTakenMul) * 100)}% DMG taken`);
              if (def.passive.damageTakenMul > 1) parts.push(`+${Math.round((def.passive.damageTakenMul - 1) * 100)}% DMG taken`);
              if (def.passive.hpRegenPct) parts.push(`${def.passive.hpRegenPct}% HP regen`);
              if (def.passive.mpCostReduction) parts.push(`-${def.passive.mpCostReduction}% MP costs`);
              if (def.passive.dodgeBonus) parts.push(`+${def.passive.dodgeBonus}% dodge`);
              if (def.passive.onHitBurnChance) parts.push(`${def.passive.onHitBurnChance}% burn`);
              if (def.passive.onHitSlowChance) parts.push(`${def.passive.onHitSlowChance}% slow`);
              if (def.passive.onHitPoisonChance) parts.push(`${def.passive.onHitPoisonChance}% poison`);
              if (def.passive.bonusHits) parts.push(`+${def.passive.bonusHits} hit`);
              if (cs.bloodrageActive) parts.push('🔥 BLOODRAGE');
              if (cs.arcaneSurgeCharges > 0) parts.push(`✨ Surge: ${cs.arcaneSurgeCharges} free`);
              if (cs.divineShield > 0) parts.push(`🛡 Shield: ${cs.divineShield}`);
              if (cs.vanishActive) parts.push('🌑 VANISHED');
              return parts.length ? '<div style="font-size:.72rem;color:rgba(167,123,255,.85);margin-top:4px">' + def.icon + ' ' + def.name + ': ' + parts.join(' · ') + '</div>' : '';
            })()}
            <div id="combatActions" class="actions" style="margin-top:16px">
              <button id="combatAttackBtn" class="primary-action" data-action="combatAction" data-type="attack">⚔ Attack</button>
              <button id="combatDefendBtn" class="secondary" data-action="combatAction" data-type="defend">🛡 Defend</button>
              ${(() => {
                const cb = state.character?.companion?.classBonus;
                if (!cb) return '';
                const def = gameData.classBonuses?.[cb] || null;
                const sp = def?.special;
                if (!sp) return '';
                const used = (cs.classCooldowns || {})[sp.slug] > 0;
                return `<button class="violet small" data-action="combatAction" data-type="classAbility" ${used ? 'disabled style="opacity:.4"' : ''}>${def.icon} ${sp.name}${used ? ' (used)' : ''}</button>`;
              })()}
              ${isArena ? '' : '<button class="danger" data-action="combatAction" data-type="flee">Flee</button>'}
            </div>
            ${(() => {
              const m = cs.momentum || 0;
              const tierNames = ['', '', '', 'Warmed Up', 'Warmed Up', 'In The Zone', 'In The Zone', 'Battle Focus', 'Battle Focus', 'Unstoppable', 'Unstoppable'];
              const tierName = tierNames[m] || '';
              const pct = (m / 10) * 100;
              const tierColor = m >= 9 ? '#fbbf24' : m >= 7 ? '#f97316' : m >= 5 ? '#3b82f6' : m >= 3 ? '#22c55e' : 'var(--muted)';
              return `<div id="combatMomentum" style="margin-top:10px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                  <span class="label" style="margin:0">⚡ Momentum</span>
                  <span style="font-size:.72rem;font-family:'Fira Code',monospace;color:${tierColor}">${tierName ? tierName + ' ' : ''}${m}/10</span>
                </div>
                <div class="bar" style="height:6px;margin:0"><div class="fill" style="width:${pct}%;background:linear-gradient(90deg,${tierColor},${tierColor}88);transition:width .4s ease"></div></div>
              </div>`;
            })()}
            <div id="combatAbilities" style="margin-top:14px">
              <div class="label">Abilities</div>
              <div class="actions" style="margin-top:8px">
                ${(state.abilities?.activeAbilities || cls?.abilities || []).map(a => {
                  const cdLeft = (cs.cooldowns || {})[a.slug] || 0;
                  const aRank = (state.character?.ability_ranks||{})[a.slug]||1; const effectiveCost = cs.dungeonMechanic === 'arcane-disruption' ? Math.ceil(getAbilityRankCost(a.cost, aRank) * 1.25) : getAbilityRankCost(a.cost, aRank);
                  const disabled = c.mp < effectiveCost || cdLeft > 0;
                  const cdLabel = cdLeft > 0 ? ` [${cdLeft}t]` : '';
                  const btnStyle = cdLeft > 0 ? 'style="opacity:.45"' : '';
                  const displayA = cs.dungeonMechanic === 'arcane-disruption' ? { ...a, cost: effectiveCost } : a;
                  return renderAbilityButton(displayA, disabled, cdLabel, btnStyle);
                }).join('') || '<span class="muted">No abilities.</span>'}
              </div>
            </div>
            ${isArena ? '' : ('<div style="margin-top:14px"><div class="label">Consumables</div><div class="actions" style="margin-top:8px">' + (consumables.map(i => '<button class="green small" data-action="combatAction" data-type="item" data-item="' + i.slug + '">' + esc(i.name) + ' ×' + i.quantity + '</button>').join('') || '<span class="muted">No items.</span>') + '</div></div>')}
            ${(cs.log?.length) ? `<hr class="story-divider"><div class="label">Combat Log</div><div class="inline-combat-log" id="inlineCombatLog">${cs.log.map(l => `<div class="combatline">${esc(l)}</div>`).join('')}</div>` : ''}
          </div>`;
        $('storyPanel').innerHTML = html;
        const combatLogEl = $('inlineCombatLog');
        if (combatLogEl) combatLogEl.scrollTop = combatLogEl.scrollHeight;
        // Trigger combat tutorial on first combat
        if (!isCombatTutDone() && !_combatTutActive && cs.turn <= 1) {
          startCombatTutorial();
        }
        return;
      }

      // ── EXPLORATION EVENT ──
      if (state.activeEvent && !c.in_combat) {

        const ev = state.activeEvent;
        if (ev.resolved && ev.outcome) {
          // Show outcome
          const o = ev.outcome;
          const rollHtml = o.rollInfo
            ? `<div style="margin-top:10px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.02);font-family:'Fira Code',monospace;font-size:.82rem">
                 🎲 <strong>${o.rollInfo.stat.toUpperCase()}</strong> check — rolled <strong>${o.rollInfo.roll}</strong> + ${o.rollInfo.modifier >= 0 ? '+' : ''}${o.rollInfo.modifier} modifier = <strong>${o.rollInfo.total}</strong> vs DC ${o.rollInfo.dc}
                 — <span style="color:${o.success ? 'var(--emerald)' : 'var(--red)'}">${o.success ? 'SUCCESS' : 'FAILED'}</span>
               </div>` : '';
          html += `
            <div style="border:1px solid rgba(214,176,95,.25);background:rgba(214,176,95,.04);border-radius:18px;padding:16px">
              <div class="eyebrow">${esc(ev.icon || '✦')} EVENT OUTCOME</div>
              <div class="enemy-name" style="font-size:1.2rem">${esc(ev.name)}</div>
              ${rollHtml}
              <div class="narrative-text" style="margin-top:12px">${esc(o.text)}</div>
              <div class="outcome-feed" style="margin-top:12px">
                ${(o.messages || []).map(m => {
                  const cls = m.includes('XP') ? 'om-reward' : m.includes('gold') ? 'om-reward' : m.includes('Healed') || m.includes('Restored') ? 'om-success' : m.includes('damage') || m.includes('💀') ? 'om-fail' : m.includes('Received') ? 'om-reward' : m.includes('Level') ? 'om-complete' : 'om-story';
                  return `<div class="outcome-msg ${cls}">${esc(m)}</div>`;
                }).join('')}
              </div>
              <div class="actions" style="margin-top:14px;justify-content:center">
                <button class="primary-action" data-action="dismissEvent">Continue Exploring</button>
              </div>
            </div>`;
          $('storyPanel').innerHTML = html;
          return;
        }
        // Show event with choices
        html += `
          <div style="border:1px solid rgba(167,123,255,.25);background:linear-gradient(180deg,rgba(38,18,59,.4),rgba(18,11,24,.4));border-radius:18px;padding:16px">
            <div class="eyebrow">${esc(ev.icon || '✦')} ${esc((ev.type || 'event').toUpperCase())} ENCOUNTER</div>
            <div class="enemy-name" style="font-size:1.2rem">${esc(ev.name)}</div>
            <div style="margin-top:4px"><span class="subtle-badge">${esc(ev.rarity || 'common')}</span></div>
            <div class="narrative-text" style="margin-top:12px">${esc(ev.text)}</div>
            <div class="quest-choices" style="margin-top:14px">
              ${(ev.choices || []).map((choice, idx) => {
                let tags = '';
                if (choice.auto) tags += `<span class="choice-tag" style="background:rgba(255,255,255,.08);color:var(--muted);border:1px solid var(--line)">AUTO</span>`;
                return `<button class="choice-btn" data-action="resolveEvent" data-idx="${idx}"><span style="flex:1">${esc(choice.label)}</span>${tags}</button>`;
              }).join('')}
            </div>
          </div>`;
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── ARENA BETWEEN WAVES ──
      if (state.arenaState && state.arenaState.betweenWaves && !c.in_combat) {

        html += renderArenaBetweenWaves();
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── PARTY COMBAT ──
      if (partyCombatData && ['submit', 'resolving', 'victory', 'wipe'].includes(partyCombatData.phase)) {
        html += renderPartyCombat();
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── PARTY RAID STATE (non-combat phases: lore, choices, pre-boss, completion) ──
      if (partyRaidState && !partyCombatData) {
        html += renderRaidState();
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── RAID TOWER SUB-VIEW ──
      if (storyView === 'raidTower') {
        html += renderRaidTowerView();
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── ARENA STORE SUB-VIEW ──
      if (storyView === 'arenaStore') {
        html += renderArenaStore();
        $('storyPanel').innerHTML = html;
        return;
      }

      if (storyView === 'classTrainer') {
        html += renderClassTrainerView();
        $('storyPanel').innerHTML = html;
        return;
      }

      if (storyView === 'progression') {
        html += renderProgressionView();
        $('storyPanel').innerHTML = html;
        return;
      }

      if (storyView === 'codex') {
        // Codex is now a modal — redirect
        storyView = 'menu'; enterCodex();
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── MARKET SUB-VIEW ──
      if (storyView === 'market' && state.shop) {
        html += renderMarketView();
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── AUCTION HOUSE SUB-VIEW ──
      if (storyView === 'auction') {
        html += renderAuctionView();
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── ACADEMY redirects to Class Trainer ──
      if (storyView === 'academy') {
        storyView = 'classTrainer';
        enterClassTrainer();
        return;
      }

      // ── GUILD SUB-VIEW ──
      if (storyView === 'guild') {
        html += renderGuildView();
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── HOME SUB-VIEW ──
      if (storyView === 'home' && (state.home?.isAtHome || state.home?.canCraftHere)) {
        html += renderHomeView();
        $('storyPanel').innerHTML = html;
        return;
      }

      // ── QUEST MODE (full takeover) ──
      if (questMode && !c.in_combat) {
        const activeQ = state.activeQuests.find(q => q.quest_slug === questMode.slug);
        if (!activeQ || !activeQ.stage_data) {
          // Quest completed or gone — exit quest mode
          questMode = null;
        } else {
          const stage = activeQ.stage_data;
          const totalStages = gameData?.questStageCounts?.[questMode.slug] || '?';
          html += `
            <div class="quest-mode-container">
              <div class="quest-mode-header">
                <div class="quest-mode-eyebrow">📜 QUEST</div>
                <div class="quest-mode-title">${esc(activeQ.title)}</div>
                <div class="quest-mode-progress">Stage ${activeQ.stage + 1}${totalStages !== '?' ? ' of ' + totalStages : ''}</div>
              </div>`;

          // Show outcome from last choice (pass/fail moment)
          if (questMode.outcome) {
            const out = questMode.outcome;
            html += `<div class="quest-outcome-box ${out.success === true ? 'qo-success' : out.success === false ? 'qo-fail' : 'qo-neutral'}">`;
            if (out.rollInfo) {
              html += `<div class="quest-roll-detail">
                🎲 <strong>${out.rollInfo.stat.toUpperCase()}</strong> check — rolled <strong>${out.rollInfo.roll}</strong> + ${out.rollInfo.modifier >= 0 ? '+' : ''}${out.rollInfo.modifier} = <strong>${out.rollInfo.total}</strong> vs DC ${out.rollInfo.dc}
                — <span style="color:${out.success ? 'var(--emerald)' : 'var(--red)'}">${out.success ? 'SUCCESS' : 'FAILED'}</span>
              </div>`;
            }
            if (out.messages?.length) {
              html += `<div class="quest-outcome-messages">${out.messages.map(m => {
                const cls = m.includes('✓') || m.includes('passed') ? 'om-success' : m.includes('⚠') || m.includes('failed') || m.includes('damage') ? 'om-fail' : m.includes('📦') || m.includes('+') || m.includes('XP') || m.includes('gold') ? 'om-reward' : m.includes('⚔') ? 'om-combat' : 'om-story';
                return '<div class="outcome-msg ' + cls + '">' + esc(m) + '</div>';
              }).join('')}</div>`;
            }
            html += `<button class="primary-action" data-action="questOutcomeContinue" style="margin-top:14px;align-self:center">Continue</button>`;
            html += `</div>`;
          } else if (!questMode.showChoices) {
            // Stage pacing: show text first, then reveal choices
            html += `<div class="narrative-text quest-narrative">${esc(stage.text)}</div>`;
            if (stage.choices?.length) {
              html += `<button class="primary-action quest-continue-btn" data-action="questRevealChoices" style="margin-top:18px">What do you do?</button>`;
            }
          } else {
            // Show text + choices
            html += `<div class="narrative-text quest-narrative">${esc(stage.text)}</div>`;
            html += `<div class="quest-choices" style="margin-top:18px">
              ${(stage.choices || []).map((choice, idx) => {
                return '<button class="choice-btn" data-action="questChoice" data-quest="' + activeQ.quest_slug + '" data-idx="' + idx + '"><span style="flex:1">' + esc(choice.label) + '</span></button>';
              }).join('')}
            </div>`;
          }

          html += `<div class="quest-mode-footer">
            <button class="muted-btn" data-action="leaveQuestMode">← Return to ${esc(state.location?.name || 'location')}</button>
          </div>`;
          html += `</div>`;
          $('storyPanel').innerHTML = html;
          return;
        }
      }

      // ── LOCATION MENU (default) ──
      // Tutorial banner
      html += renderTutorialBanner();
      // Location banner + header
      html += renderLocationBanner(c.location);
      html += `
        <div class="eyebrow">${locIcon(state.location?.type)} ${esc((state.location?.type || '').toUpperCase())}</div>
        <h2 style="margin-bottom:4px">${esc(state.location?.name || c.location)}</h2>
        <div class="muted">${esc(state.location?.description || '')}</div>`;

      // Dungeon progress
      if (isDungeon && ds) {

        const progressPct = Math.max(0, Math.min(100, (ds.roomsCleared / ds.totalRooms) * 100));
        const remaining = ds.totalRooms - ds.roomsCleared;
        const nextIsBoss = remaining === 1;
        html += `
          <div class="dungeon-box" style="margin-top:14px">
            <div class="eyebrow">🏰 DUNGEON IN PROGRESS</div>
            <div style="margin-top:6px"><strong>${esc(state.dungeonConfig?.name || 'Dungeon')}</strong></div>
            <div class="muted" style="margin-top:4px">Rooms cleared: ${ds.roomsCleared} / ${ds.totalRooms}</div>
            <div class="bar" style="margin-top:8px"><div class="fill dungeon" style="width:${progressPct}%"></div></div>
            <div style="margin-top:4px" class="muted">${remaining} room${remaining !== 1 ? 's' : ''} left${nextIsBoss ? ' — 🔥 BOSS AHEAD!' : ''}</div>
          </div>`;
      }

      // ── Action menu ──
      html += `<div class="action-menu">`;

      // Explore / Dungeon action
      // Bounty hint — shown on explore/dungeon buttons when targets are here
      const bountiesHere = state.guild?.activeBountiesHere || [];
      const bountyHint = bountiesHere.length > 0
        ? `<div style="margin-top:2px;font-size:.75rem;color:#5882be">📋 Bounty target${bountiesHere.length>1?'s':''} here: ${bountiesHere.map(b => `${esc(b.enemyName)} (${b.kills}/${b.killTarget})`).join(', ')}</div>`
        : '';

      if (isDungeon && ds) {
        const remaining = ds.totalRooms - ds.roomsCleared;
        const nextIsBoss = remaining === 1;
        html += `
          <button class="action-card" data-action="explore">
            <span class="action-icon">${nextIsBoss ? '🔥' : '⚔'}</span>
            <div><div class="action-label">${nextIsBoss ? 'Face the Boss' : 'Continue Deeper'}</div>
            <div class="action-desc">${nextIsBoss ? 'The final chamber awaits' : `Clear room ${ds.roomsCleared + 1} of ${ds.totalRooms}`}${bountyHint}</div></div>
          </button>
          <button class="action-card" data-action="leaveDungeon">
            <span class="action-icon">🚪</span>
            <div><div class="action-label">Leave Dungeon</div>
            <div class="action-desc">Retreat and lose dungeon progress</div></div>
          </button>`;
      } else if (isDungeon) {
        html += `
          <button class="action-card" data-action="explore">
            <span class="action-icon">🏰</span>
            <div><div class="action-label">Enter Dungeon</div>
            <div class="action-desc">${esc(state.dungeonConfig?.name || 'Explore the depths')}${bountyHint}</div></div>
          </button>`;
      } else if (gated) {
        html += `<div class="gated-notice">📜 Complete available quests here before exploring the wilds.</div>`;
      } else if (hasEnemies) {
        html += `
          <button class="action-card" data-action="explore">
            <span class="action-icon">⚔</span>
            <div><div class="action-label">Explore the Wilds</div>
            <div class="action-desc">Hunt for enemies, XP, and loot${bountyHint}</div></div>
          </button>`;
      }

      // Market (if shop available)
      if (state.shop) {
        html += `
          <button class="action-card" data-action="enterMarket">
            <span class="action-icon">🏪</span>
            <div><div class="action-label">Visit the Market</div>
            <div class="action-desc">Buy supplies and sell loot</div></div>
          </button>`;
      }

      if (state.home?.isAtHome) {
        html += `
          <button class="action-card" data-action="enterHome">
            <span class="action-icon">🏠</span>
            <div><div class="action-label">Return Home</div>
            <div class="action-desc">Access storage, crafting, and the Forge</div></div>
          </button>`;
      } else if (state.home?.canCraftHere) {
        html += `
          <button class="action-card" data-action="enterHome">
            <span class="action-icon">🔨</span>
            <div><div class="action-label">Workshop & Forge</div>
            <div class="action-desc">Craft gear and enchant equipment (storage at Thornwall)</div></div>
          </button>`;
      }

      // Adventurer's Guild (at towns with bounty boards)
      if (state.guild?.hasBountyBoard) {
        const guildLabel = state.guild.registered
          ? `Bounty Board & Guild Vendor (Rank: ${state.guild.rankInfo?.name || 'Initiate'})`
          : `Join the Adventurer's Guild (${state.guild.registrationCost}g)`;
        html += `
          <button class="action-card" data-action="enterGuild">
            <span class="action-icon">⚔</span>
            <div><div class="action-label">Adventurer's Guild</div>
            <div class="action-desc">${guildLabel}</div></div>
          </button>`;
      }

      // Auction House (at any town)
      if (state.hasAuctionHouse) {
        html += `
          <button class="action-card" data-action="enterAuction">
            <span class="action-icon">🏛</span>
            <div><div class="action-label">Auction House</div>
            <div class="action-desc">Buy and sell items with other players</div></div>
          </button>`;
      }

      // Arena (at any town)
      if (state.hasArena && !state.arenaState) {
        const bestWave = state.arenaBestWave || 0;
        html += `
          <button class="action-card" data-action="enterArena">
            <span class="action-icon">🏟</span>
            <div><div class="action-label">The Arena</div>
            <div class="action-desc">Wave survival for Arena Points (🏟 ${c.arena_points || 0} AP)${bestWave ? ` · Personal best: <strong style="color:#fbbf24">Wave ${bestWave}</strong>` : ''}</div></div>
          </button>`;
      }
      if (state.hasArena) {
        html += `
          <button class="action-card" data-action="enterArenaStore">
            <span class="action-icon">🛡</span>
            <div><div class="action-label">Arena Store</div>
            <div class="action-desc">Spend Arena Points on exclusive gear</div></div>
          </button>`;
      }

      // Raid Tower (Sunspire)
      if (state.hasRaidTower && !state.raidState && !partyRaidState) {
        html += `
          <button class="action-card" data-action="enterRaidTower">
            <span class="action-icon">🕳</span>
            <div><div class="action-label">The Raid Tower</div>
            <div class="action-desc">Multi-floor raids with unique enemies, lore, and powerful bosses</div></div>
          </button>`;
      }

      // Class Trainer (Ironhold)
      if (state.hasClassTrainer) {
        const compIcon = state.character?.companion ? (GAME_CONFIG_COMP_ICONS[state.character.companion.type] || '🐾') : '⚔';
        html += `
          <button class="action-card" data-action="enterClassTrainer">
            <span class="action-icon">${compIcon}</span>
            <div><div class="action-label">Class Trainer</div>
            <div class="action-desc">Abilities, loadout, class quests, and specialization (✦ ${state.character?.arcane_tokens || 0} Tokens)</div></div>
          </button>`;
      }

      // Inn (if available)
      if (state.inn) {
        html += `
          <button class="action-card" data-action="rest">
            <span class="action-icon">🏨</span>
            <div><div class="action-label">Rest at the Inn</div>
            <div class="action-desc">Restore HP & MP (${state.inn} gold)</div></div>
          </button>`;
      }

      html += `</div>`; // end action-menu

      // ── Outcome messages from last action ──
      if (lastMessages.length) {
        html += `<div class="outcome-feed">${lastMessages.map(m =>
          `<div class="outcome-msg ${classifyOutcome(m)}">${esc(m)}</div>`
        ).join('')}</div>`;
      }

      // ── Quest indicators (entry points to quest mode) ──
      const sortedActiveQuests = [...state.activeQuests].sort((a, b) =>
        (a.title || '').localeCompare(b.title || '') ||
        (a.stage || 0) - (b.stage || 0) ||
        (a.quest_slug || '').localeCompare(b.quest_slug || '')
      );
      const hasActiveQuest = sortedActiveQuests.length > 0;
      const questsHere = sortedActiveQuests.filter(q => {
        const def = gameData?.questDefs?.find(d => d.slug === q.quest_slug);
        return def?.location === c.location;
      });
      const questsElsewhere = sortedActiveQuests.filter(q => {
        const def = gameData?.questDefs?.find(d => d.slug === q.quest_slug);
        return !def || def.location !== c.location;
      });

      // Active quest at this location — prominent entry
      if (questsHere.length) {
        html += `<hr class="story-divider">`;
        for (const q of questsHere) {
          const totalStages = gameData?.questStageCounts?.[q.quest_slug] || '?';
          const hasChoices = q.stage_data?.choices?.length > 0;
          html += `
            <div class="quest-entry-card ${hasChoices ? 'quest-actionable' : 'quest-waiting'}" ${hasChoices ? 'data-action="enterQuestMode" data-slug="' + q.quest_slug + '" style="cursor:pointer"' : ''}>
              <div class="quest-entry-icon">📜</div>
              <div class="quest-entry-body">
                <div class="quest-entry-title">${esc(q.title)}</div>
                <div class="quest-entry-stage">Stage ${q.stage + 1}${totalStages !== '?' ? ' of ' + totalStages : ''}${hasChoices ? ' — <span style="color:var(--gold)">Choices await</span>' : ' — <span class="muted">In progress</span>'}</div>
              </div>
              ${hasChoices ? '<div class="quest-entry-arrow">›</div>' : ''}
            </div>`;
        }
      }

      // Quest tracker for quests at other locations
      if (questsElsewhere.length) {
        html += `<div class="quest-tracker" style="margin-top:14px">
          <div class="label" style="margin-bottom:6px">Active Quests (elsewhere)</div>
          ${questsElsewhere.map(q => {
            const def = gameData?.questDefs?.find(d => d.slug === q.quest_slug);
            const locName = def?.locationName || def?.location || '?';
            return '<div class="quest-tracker-item"><span class="qt-title">📜 ' + esc(q.title) + '</span><span class="qt-status">— at ' + esc(locName) + '</span></div>';
          }).join('')}
        </div>`;
      }

      // Available quests
      const visibleAvailableQuests = hasActiveQuest ? [] : [...state.availableQuests].sort((a, b) =>
        (a.minLevel || 1) - (b.minLevel || 1) ||
        (a.title || '').localeCompare(b.title || '') ||
        (a.slug || '').localeCompare(b.slug || '')
      ).slice(0, 1);
      if (hasActiveQuest && !questsHere.length) {
        // Don't show "complete your quest" nag if the active quest entry is already visible above
      } else if (visibleAvailableQuests.length) {
        html += `<hr class="story-divider">`;
        for (const q of visibleAvailableQuests) {
          html += `
            <div class="quest-entry-card quest-available">
              <div class="quest-entry-icon">📜</div>
              <div class="quest-entry-body">
                <div class="quest-entry-title">${esc(q.title)}</div>
                <div class="quest-entry-stage"><span class="muted">Lv ${q.minLevel}+ — ${esc(q.description?.substring(0, 80) || '')}${(q.description?.length || 0) > 80 ? '…' : ''}</span></div>
              </div>
              <div class="quest-entry-actions"><button class="green small" data-action="acceptQuest" data-slug="${q.slug}">Accept</button></div>
            </div>`;
        }
      }

      $('storyPanel').innerHTML = html;
    }

    // ══════════════════════════════════════════
    //  MARKET SUB-VIEW (inline in story panel)
    // ══════════════════════════════════════════
    function renderMarketView() {
      let tipHtml = renderTutorialBanner();
      const c = state.character;
      const myPrimary = CLASS_PRIMARY_STAT[c.class] || 'str';
      const mySecondary = CLASS_SECONDARY_STAT[c.class] || 'con';

      const sellable = state.inventory.filter(i => i.sell > 0);
      const repairable = EQUIP_SLOTS.filter(slot => {
        const eq = state.equipment[slot];
        return eq && eq.durability < eq.maxDurability;
      });

      let html = tipHtml + `
        <div class="market-header">
          <div>
            <div class="eyebrow">🏪 MARKET</div>
            <h3 style="margin:0">${esc(state.location?.name)} Shop</h3>
          </div>
          <div class="market-gold">💰 ${c.gold}g &nbsp; <span style="color:#5882be">⚔ ${c.guild_marks||0}</span> &nbsp; <span style="color:#9068d0">✦ ${c.arcane_tokens||0}</span></div>
        </div>
        <div class="shop-tabs">
          <button class="shop-tab${shopTab==='buy'?' active':''}" data-action="setShopTab" data-tab="buy">Buy<span class="tab-count">(${state.shop?.length||0})</span></button>
          <button class="shop-tab${shopTab==='sell'?' active':''}" data-action="setShopTab" data-tab="sell">Sell<span class="tab-count">(${sellable.length})</span></button>
          <button class="shop-tab${shopTab==='repair'?' active':''}" data-action="setShopTab" data-tab="repair">Repair${repairable.length?`<span class="tab-count" style="color:var(--ember)">(${repairable.length})</span>`:''}</button>
          ${(state.buyback?.length) ? `<button class="shop-tab${shopTab==='buyback'?' active':''}" data-action="setShopTab" data-tab="buyback">Buyback<span class="tab-count">(${state.buyback.length})</span></button>` : ''}
        </div>`;

      const slotFilters = shopTab === 'sell'
        ? ['all', ...EQUIP_SLOTS, 'consumable', 'material', 'gem', 'crystal']
        : ['all', 'myclass', ...EQUIP_SLOTS, 'consumable', 'material', 'gem', 'crystal'];
      const slotLabels = { all:'All', myclass:'⭐ My Class', weapon:'Weapon', shield:'Shield', body:'Armor', helmet:'Helmet', gloves:'Gloves', boots:'Boots', amulet:'Amulet', ring:'Ring', trinket:'Trinket', consumable:'Consumable', material:'Material', gem:'💎 Gem', crystal:'🔮 Crystal' };

      // ── BUY TAB ──
      if (shopTab === 'buy') {
        html += `<div class="shop-filters">${slotFilters.map(f =>
          `<button class="${shopSlotFilter===f?'':'secondary'} small" data-action="setShopSlotFilter" data-filter="${f}">${slotLabels[f]||f}</button>`
        ).join('')}</div>`;

        let items = state.shop || [];
        if (shopSlotFilter === 'myclass') {
          items = items.filter(i => {
            if (!i.stats) return false;
            const topStat = Object.entries(i.stats).sort((a,b) => b[1]-a[1])[0];
            return topStat && (topStat[0] === myPrimary || topStat[0] === mySecondary);
          });
        } else if (shopSlotFilter !== 'all') {
          items = items.filter(i => i.type === shopSlotFilter);
        }
        const rarityOrder = { common:0, uncommon:1, rare:2, epic:3, legendary:4, mythic:5 };
        const slotOrder = {}; EQUIP_SLOTS.forEach((s,i) => slotOrder[s] = i); slotOrder['consumable'] = 100; slotOrder['material'] = 101;
        items.sort((a,b) => (slotOrder[a.type]??99) - (slotOrder[b.type]??99) || (rarityOrder[a.rarity]??0) - (rarityOrder[b.rarity]??0) || a.cost - b.cost);

        if (!items.length) {
          html += `<div class="shop-empty">${shopSlotFilter==='myclass'?'No items match your class here.':'Nothing for sale in this category.'}</div>`;
        } else {
          // Auto-select first if nothing selected
          if (!selectedShopItem && items.length) selectedShopItem = items[0].slug;
          const sel = items.find(i => i.slug === selectedShopItem) || null;
          const equipped = sel ? getEquippedItemFor(sel) : null;

          html += `<div class="ah-panels">`;
          // Left: item list
          html += `<div class="ah-item-list">`;
          html += items.map(item => {
            const isSel = item.slug === selectedShopItem;
            return `<div class="ah-list-item${isSel ? ' selected' : ''}" data-action="selectShopItem" data-id="${item.slug}">
              <span class="ali-slot">${esc(item.type||'')}</span>
              <span class="ali-name rarity-${item.rarity}">${esc(item.name)}</span>
              <span class="ali-price">${item.cost}g</span>
            </div>`;
          }).join('');
          html += `</div>`;

          // Right: detail pane
          html += `<div class="ah-detail">`;
          if (sel) {
            const compareStats = equipped?.stats || null;
            html += `
              <div class="eyebrow" style="margin-bottom:4px">${esc(sel.type||'').toUpperCase()}</div>
              <h3 style="margin:0 0 4px"><span class="rarity-${sel.rarity}">${esc(sel.name)}</span></h3>
              <div class="mono muted" style="font-size:.76rem">${sel.rarity}${sel.levelReq ? ' · Lv ' + sel.levelReq + '+' : ''}</div>
              ${sel.description ? `<div class="muted" style="font-size:.85rem;margin-top:6px">${esc(sel.description)}</div>` : ''}
              ${renderStatSummary(sel.stats || {}, { compareStats, myPrimary })}
              ${renderItemEffectSummary(sel)}
              ${equipped ? `<div class="compare-hint muted" style="font-size:.72rem">Compared to equipped: <strong class="rarity-${equipped.rarity||'common'}">${esc(equipped.name||'—')}</strong></div>` : ''}
              <div class="ah-detail-price" style="margin-top:12px">💰 ${sel.cost}g</div>
              <button data-action="buyItem" data-slug="${sel.slug}" ${c.gold < sel.cost ? 'disabled' : ''} style="width:100%">${c.gold < sel.cost ? 'Not enough gold' : 'Buy for ' + sel.cost + 'g'}</button>`;
          } else {
            html += `<div class="ah-detail-empty">Select an item to view details</div>`;
          }
          html += `</div></div>`;
        }
      }

      // ── SELL TAB ──
      if (shopTab === 'sell') {
        html += `<div class="shop-filters">${slotFilters.map(f =>
          `<button class="${shopSlotFilter===f?'':'secondary'} small" data-action="setShopSlotFilter" data-filter="${f}">${slotLabels[f]||f}</button>`
        ).join('')}</div>`;

        let items = sellable;
        if (shopSlotFilter !== 'all') items = items.filter(i => i.type === shopSlotFilter);
        items.sort((a,b) => b.sell - a.sell);

        if (!items.length) {
          html += `<div class="shop-empty">Nothing to sell${shopSlotFilter!=='all'?' in this category':''}.</div>`;
        } else {
          // Sell All Junk bar
          const junkItems = items.filter(i => i.junk);
          const totalJunkValue = junkItems.reduce((sum, i) => sum + (i.sell * i.quantity), 0);
          if (junkItems.length > 0) {
            html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:6px 12px;border:1px solid rgba(255,90,90,.2);border-radius:10px;background:rgba(255,90,90,.04)">
              <span style="font-size:.82rem;color:var(--muted)">🗑 ${junkItems.length} junk · <span style="color:var(--emerald)">${totalJunkValue}g</span></span>
              <button class="danger small" data-action="sellAllJunk">Sell All Junk</button>
            </div>`;
          }

          // Unique key for sell items (perked items use inventoryId, stacked use slug)
          const itemKey = (item) => item.inventoryId ? 'inv-' + item.inventoryId : item.slug;
          if (!selectedShopItem && items.length) selectedShopItem = itemKey(items[0]);
          const sel = items.find(i => itemKey(i) === selectedShopItem) || null;

          html += `<div class="ah-panels">`;
          // Left: item list
          html += `<div class="ah-item-list">`;
          html += items.map(item => {
            const key = itemKey(item);
            const isSel = key === selectedShopItem;
            return `<div class="ah-list-item${isSel ? ' selected' : ''}${item.junk ? ' junk-item' : ''}" data-action="selectShopItem" data-id="${key}">
              <span class="ali-slot">${esc(item.type||'')}</span>
              <span class="ali-name rarity-${item.rarity}">${item.junk ? '<span style="opacity:.5">🗑 </span>' : ''}${esc(item.name)}${item.quantity>1?' <span class="muted">×'+item.quantity+'</span>':''}</span>
              <span class="ali-price" style="color:var(--emerald)">${item.sell}g</span>
            </div>`;
          }).join('');
          html += `</div>`;

          // Right: detail pane
          html += `<div class="ah-detail">`;
          if (sel) {
            const isStackable = sel.quantity > 1 && !sel.perks;
            const totalValue = sel.sell * sel.quantity;
            html += `
              <div class="eyebrow" style="margin-bottom:4px">${esc(sel.type||'').toUpperCase()}</div>
              <h3 style="margin:0 0 4px"><span class="rarity-${sel.rarity}">${esc(sel.name)}</span>${sel.quantity>1?` <span class="muted" style="font-size:.85rem">×${sel.quantity}</span>`:''}</h3>
              <div class="mono muted" style="font-size:.76rem">${sel.rarity}</div>
              ${sel.description ? `<div class="muted" style="font-size:.85rem;margin-top:6px">${esc(sel.description)}</div>` : ''}
              ${renderStatSummary(sel.stats || {}, { myPrimary })}
              ${renderItemEffectSummary(sel)}
              ${renderPerks(sel.perks)}
              <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                  <span class="muted" style="font-size:.82rem">Sell price</span>
                  <span style="color:var(--emerald);font-weight:700;font-size:1.1rem">${sel.sell}g each</span>
                </div>
                ${isStackable ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                  <span class="muted" style="font-size:.82rem">Total (×${sel.quantity})</span>
                  <span style="color:var(--emerald);font-weight:700">${totalValue}g</span>
                </div>` : ''}
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                  <button class="secondary" data-action="sellItem" data-item-slug="${sel.slug}" data-inventory-id="${sel.inventoryId || ''}" data-qty="1" style="flex:1">Sell 1 · ${sel.sell}g</button>
                  ${isStackable ? `<button class="secondary" data-action="sellBulk" data-item-slug="${sel.slug}" data-max-qty="${sel.quantity}" data-sell-price="${sel.sell}" style="flex:1">Sell…</button>
                  <button class="green" data-action="sellItem" data-item-slug="${sel.slug}" data-inventory-id="" data-qty="${sel.quantity}" style="flex:1">Sell All · ${totalValue}g</button>` : ''}
                </div>
              </div>`;
          } else {
            html += `<div class="ah-detail-empty">Select an item to view details</div>`;
          }
          html += `</div></div>`;
        }
      }

      // ── REPAIR TAB ──
      if (shopTab === 'repair') {
        if (repairable.length) {
          const REPAIR_MULT = { common:1, uncommon:2, rare:4, epic:8, legendary:12, mythic:16 };
          let totalRepairCost = 0;
          const repairItems = repairable.map(slot => {
            const eq = state.equipment[slot];
            const cost = Math.max(1, Math.floor((eq.maxDurability - eq.durability) * 2 * (REPAIR_MULT[eq.rarity] || 1)));
            totalRepairCost += cost;
            return { slot, eq, cost };
          });

          if (!selectedShopItem && repairItems.length) selectedShopItem = repairItems[0].slot;
          const sel = repairItems.find(r => r.slot === selectedShopItem) || null;

          html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div class="label">REPAIR (${repairable.length} item${repairable.length>1?'s':''})</div>
            <button class="green small" data-action="repairAll" ${c.gold < totalRepairCost ? 'disabled' : ''}>🔧 Repair All (${totalRepairCost}g)</button>
          </div>`;

          html += `<div class="ah-panels">`;
          // Left: slot list
          html += `<div class="ah-item-list">`;
          html += repairItems.map(r => {
            const isSel = r.slot === selectedShopItem;
            const durPct = Math.round((r.eq.durability / r.eq.maxDurability) * 100);
            const durColor = durPct <= 20 ? 'var(--ember)' : durPct <= 50 ? '#fbbf24' : 'var(--emerald)';
            return `<div class="ah-list-item${isSel ? ' selected' : ''}" data-action="selectShopItem" data-id="${r.slot}">
              <span class="ali-slot">${esc(r.slot)}</span>
              <span class="ali-name" style="flex:1">${esc(r.eq.name)} <span style="color:${durColor};font-size:.72rem">${durPct}%</span></span>
              <span class="ali-price">${r.cost}g</span>
            </div>`;
          }).join('');
          html += `</div>`;

          // Right: repair detail
          html += `<div class="ah-detail">`;
          if (sel) {
            const durPct = Math.round((sel.eq.durability / sel.eq.maxDurability) * 100);
            const durColor = durPct <= 20 ? 'var(--ember)' : durPct <= 50 ? '#fbbf24' : 'var(--emerald)';
            html += `
              <div class="eyebrow" style="margin-bottom:4px">${esc(sel.slot).toUpperCase()}</div>
              <h3 style="margin:0 0 4px"><span class="rarity-${sel.eq.rarity||'common'}">${esc(sel.eq.name)}</span></h3>
              <div class="mono muted" style="font-size:.76rem">${sel.eq.rarity || 'common'}</div>
              ${renderStatSummary(sel.eq.stats || {}, { myPrimary })}
              ${renderPerks(sel.eq.perks)}
              <div style="margin-top:14px">
                <div class="label" style="margin-bottom:4px">DURABILITY</div>
                <div style="display:flex;align-items:center;gap:10px">
                  <span style="color:${durColor};font-weight:700;font-size:1.1rem">${sel.eq.durability}</span>
                  <span class="muted">/</span>
                  <span style="font-weight:600">${sel.eq.maxDurability}</span>
                </div>
                <div class="bar" style="margin-top:6px"><div class="fill ${durPct <= 20 ? 'dur-low' : 'dur'}" style="width:${durPct}%"></div></div>
              </div>
              <div class="ah-detail-price" style="margin-top:12px">🔧 ${sel.cost}g</div>
              <button class="green" data-action="repair" data-slot="${sel.slot}" ${c.gold < sel.cost ? 'disabled' : ''} style="width:100%">${c.gold < sel.cost ? 'Not enough gold' : 'Repair for ' + sel.cost + 'g'}</button>`;
          } else {
            html += `<div class="ah-detail-empty">Select an item to repair</div>`;
          }
          html += `</div></div>`;
        } else {
          html += `<div class="shop-empty">All equipment is in good condition.</div>`;
        }
      }

      if (shopTab === 'buyback') {
        const buybackItems = state.buyback || [];
        if (buybackItems.length) {
          html += `<div class="muted" style="font-size:.8rem;margin-bottom:10px">Recently sold items. Repurchase at the sell price.</div>`;
          html += buybackItems.map((entry, idx) => {
            const hasPerks = entry.perks && entry.perks.length > 0;
            const label = entry.quantity > 1 ? `${entry.name} ×${entry.quantity}` : entry.name;
            return `<div class="ah-list-item" style="display:flex;align-items:center;gap:8px;cursor:default">
              <span class="ali-name rarity-${entry.rarity}">${hasPerks ? '✦ ' : ''}${esc(label)}</span>
              <span class="muted" style="font-size:.75rem;margin-left:auto">${entry.sellPrice}g</span>
              <button class="small green" data-action="shopBuyback" data-value="${idx}" ${c.gold < entry.sellPrice ? 'disabled' : ''} style="padding:3px 10px;font-size:.72rem">Buy Back</button>
            </div>`;
          }).join('');
        } else {
          html += `<div class="shop-empty">No recent sales to buy back.</div>`;
        }
      }

      html += `<div style="margin-top:18px;text-align:center">
        <button class="secondary" data-action="leaveMarket">← Leave Store</button>
      </div>`;

      return html;
    }

    let academyTab = 'loadout';
    let academyFilter = 'all';
    let selectedTalent = null;
    let pendingLoadout = null;

    // Auction House state
    let ahTab = 'browse';
    let ahSlotFilter = 'all';
    let ahRarityFilter = 'all';
    let ahSort = 'price-asc';
    let ahPage = 1;
    let ahListings = null;
    let ahSelectedId = null;
    let ahPriceHistory = {};
    let ahTotalPages = 1;
    let ahMyListings = null;
    let ahSellItem = null;
    let ahSellPrice = '';

    function setAhTab(tab) { ahTab = tab; if (tab === 'browse') ahListings = null; if (tab === 'my') ahMyListings = null; if (tab === 'sell') { ahSellItem = null; ahSellPrice = ''; } renderGame(); }
    function setAhSlotFilter(f) { ahSlotFilter = f; ahPage = 1; ahListings = null; ahSelectedId = null; renderGame(); }
    function setAhRarityFilter(f) { ahRarityFilter = f; ahPage = 1; ahListings = null; ahSelectedId = null; renderGame(); }
    function setAhSort(s) { ahSort = s; ahPage = 1; ahListings = null; ahSelectedId = null; renderGame(); }
    function selectAhListing(id) { ahSelectedId = ahSelectedId === Number(id) ? null : Number(id); renderGame(); }
    function ahNextPage() { ahPage++; ahListings = null; renderGame(); }
    function ahPrevPage() { ahPage = Math.max(1, ahPage - 1); ahListings = null; renderGame(); }

    function renderAuctionView() {
      const c = state.character;

      let html = `
        <div class="guild-header">
          <div>
            <div class="eyebrow">🏛 AUCTION HOUSE</div>
            <h3 style="margin:0">Global Market</h3>
          </div>
          <div class="market-gold">💰 ${c.gold}g</div>
        </div>
        <div class="shop-tabs">
          <button class="shop-tab${ahTab==='browse'?' active':''}" data-action="ahSetTab" data-tab="browse">Browse</button>
          <button class="shop-tab${ahTab==='sell'?' active':''}" data-action="ahSetTab" data-tab="sell">Sell</button>
          <button class="shop-tab${ahTab==='my'?' active':''}" data-action="ahSetTab" data-tab="my">My Listings</button>
        </div>`;

      // ── BROWSE TAB ──
      if (ahTab === 'browse') {
        const myPrimary = CLASS_PRIMARY_STAT[c.class] || 'str';
        const slotOpts = ['all', 'my-class', ...EQUIP_SLOTS, 'consumable', 'material', 'gem', 'crystal'];
        const slotLabelsAh = { all: 'All', 'my-class': '⚔ My Class', weapon: 'Weapon', shield: 'Shield', body: 'Armor', helmet: 'Helmet', gloves: 'Gloves', boots: 'Boots', amulet: 'Amulet', ring: 'Ring', trinket: 'Trinket', consumable: 'Consumable', material: 'Material', gem: '💎 Gem', crystal: '🔮 Crystal' };
        const rarityOpts = ['all', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
        const sortOpts = [['price-asc','Price ▲'],['price-desc','Price ▼'],['rarity','Rarity'],['newest','Newest']];
        html += `<div class="shop-filters" style="margin-bottom:6px">
          ${slotOpts.map(f => `<button class="${ahSlotFilter===f?'':'secondary'} small" data-action="ahSetSlotFilter" data-filter="${f}">${slotLabelsAh[f]||f}</button>`).join('')}
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
          <span class="muted" style="font-size:.72rem">Rarity:</span>
          ${rarityOpts.map(f => `<button class="${ahRarityFilter===f?'':'secondary'} small" data-action="ahSetRarityFilter" data-filter="${f}">${f==='all'?'All':f[0].toUpperCase()+f.slice(1)}</button>`).join('')}
          <span style="margin-left:auto"></span>
          <span class="muted" style="font-size:.72rem">Sort:</span>
          ${sortOpts.map(([v,l]) => `<button class="${ahSort===v?'':'secondary'} small" data-action="ahSetSort" data-value="${v}">${l}</button>`).join('')}
        </div>`;

        if (!ahListings) {
          html += `<div class="shop-empty">Loading listings...</div>`;
          loadAhBrowse();
        } else if (ahListings.length === 0) {
          html += `<div class="shop-empty">No listings found.</div>`;
        } else {
          // Client-side "My Class" filter — show items with primary stat bonus
          let displayListings = ahListings;
          if (ahSlotFilter === 'my-class') {
            displayListings = ahListings.filter(l => {
              const itemDef = getItemDef(l.itemSlug);
              if (!itemDef?.stats) return false;
              // Show items that have the class primary stat > 0
              return (itemDef.stats[myPrimary] || 0) > 0;
            });
          }

          // Two-panel layout
          const selListing = displayListings.find(l => l.id === ahSelectedId) || null;
          // Auto-select first if nothing selected
          if (!selListing && displayListings.length && !ahSelectedId) {
            ahSelectedId = displayListings[0].id;
          }
          const sel = displayListings.find(l => l.id === ahSelectedId) || null;

          html += `<div class="ah-panels">`;

          // Left: item list
          html += `<div class="ah-item-list">`;
          if (displayListings.length) {
            html += displayListings.map(l => {
              const isSel = l.id === ahSelectedId;
              const totalPrice = l.price * l.quantity;
              return `<div class="ah-list-item ${isSel ? 'selected' : ''}" data-action="selectAhListing" data-id="${l.id}" data-num-id="1">
                <span class="ali-slot">${esc(l.itemType)}</span>
                <span class="ali-name rarity-${l.itemRarity}">${esc(l.itemName)}${l.quantity>1?' <span class="muted">×'+l.quantity+'</span>':''}</span>
                <span class="ali-price">${totalPrice}g</span>
              </div>`;
            }).join('');
          } else {
            html += `<div style="padding:16px;color:var(--muted);text-align:center;font-style:italic">No items match this filter.</div>`;
          }
          html += `</div>`;

          // Right: detail pane
          html += `<div class="ah-detail">`;
          if (sel) {
            const itemDef = getItemDef(sel.itemSlug);
            const stats = itemDef?.stats;
            const totalPrice = sel.price * sel.quantity;
            const recentPrice = ahPriceHistory[sel.itemSlug];
            const parsedPerks = sel.itemPerks ? (typeof sel.itemPerks === 'string' ? JSON.parse(sel.itemPerks) : sel.itemPerks) : null;

            html += `
              <div class="eyebrow" style="margin-bottom:4px">${esc(sel.itemType).toUpperCase()}</div>
              <h3 style="margin:0 0 4px"><span class="rarity-${sel.itemRarity}">${esc(sel.itemName)}</span></h3>
              <div class="mono muted" style="font-size:.76rem">Rarity: ${sel.itemRarity}${sel.quantity > 1 ? ' · Qty: ' + sel.quantity : ''}</div>
              ${itemDef?.description ? `<div class="muted" style="font-size:.85rem;margin-top:6px">${esc(itemDef.description)}</div>` : ''}
              ${renderStatSummary(stats, { myPrimary })}
              ${renderItemEffectSummary(itemDef || {})}
              ${renderPerks(parsedPerks)}
              <div class="ah-detail-seller">Listed by ${esc(sel.sellerName)}${recentPrice ? ` · Last sold: ${recentPrice}g` : ''}</div>
              <div class="ah-detail-price">💰 ${totalPrice}g</div>
              ${sel.isMine
                ? '<span class="muted" style="font-size:.82rem">This is your listing</span>'
                : `<button data-action="ahBuy" data-id="${sel.id}" data-num-id="1" ${c.gold < totalPrice ? 'disabled' : ''}>${c.gold < totalPrice ? 'Not enough gold' : 'Buy Now'}</button>`
              }`;
          } else {
            html += `<div class="ah-detail-empty">Select a listing to view details</div>`;
          }
          html += `</div></div>`;

          // Pagination
          if (ahTotalPages > 1) {
            html += `<div style="display:flex;justify-content:center;gap:12px;margin-top:10px;align-items:center">
              <button class="secondary small" data-action="ahPrevPage" ${ahPage<=1?'disabled':''}>← Prev</button>
              <span class="muted" style="font-size:.78rem">Page ${ahPage} of ${ahTotalPages}</span>
              <button class="secondary small" data-action="ahNextPage" ${ahPage>=ahTotalPages?'disabled':''}>Next →</button>
            </div>`;
          }
        }
      }

      // ── SELL TAB ──
      if (ahTab === 'sell') {
        if (!ahSellItem) {
          // Pick item from inventory
          html += `<div class="label" style="margin-bottom:8px">SELECT ITEM TO LIST</div>`;
          const sellable = state.inventory.filter(i => i.sell > 0);
          if (sellable.length) {
            html += sellable.map(item => {
              const hasPerks = item.perks?.length;
              return `<div class="ah-listing" style="cursor:pointer" data-action="ahSelectSellItem" data-item-slug="${item.slug}" data-inventory-id="${item.inventoryId || 'null'}" data-qty="${item.quantity}" data-name="${esc(item.name)}" data-rarity="${item.rarity}" data-vendor-price="${item.sell}">
                <div class="shop-row-slot">${esc(item.type||'')}</div>
                <div class="ah-listing-info">
                  <div class="ah-listing-name rarity-${item.rarity}">${renderRarityName(item)}${item.quantity>1?' <span class="muted">×'+item.quantity+'</span>':''}${hasPerks?`<span class="ah-perk-tag">${item.perks.length} perk${item.perks.length>1?'s':''}</span>`:''}</div>
                  <div class="ah-listing-meta">${item.stats ? Object.entries(item.stats).filter(([,v])=>v).map(([k,v]) => `${v>0?'+':''}${v} ${k.toUpperCase()}`).join(' ') : esc(item.description||'')}</div>
                </div>
                <div class="muted" style="font-size:.72rem">Vendor: ${item.sell}g</div>
              </div>`;
            }).join('');
          } else {
            html += `<div class="shop-empty">Nothing to sell.</div>`;
          }
        } else {
          // Set price for selected item
          html += `<div class="ah-sell-preview">
            <div style="font-weight:600;font-size:.92rem;margin-bottom:8px">List: <span class="rarity-${ahSellItem.rarity}">${esc(ahSellItem.name)}</span></div>
            <div class="ah-fee-line"><span>Asking price:</span><input type="number" min="1" value="${ahSellPrice}" id="ahPriceInput" style="width:80px;text-align:right;background:var(--bg);border:1px solid var(--line);color:var(--text);padding:4px 8px;border-radius:6px;font-size:.88rem"> g</div>
            <div class="ah-fee-line"><span>Vendor value:</span><span class="muted">${ahSellItem.vendorPrice}g</span></div>
            <div class="ah-fee-line muted" style="font-size:.75rem;margin-top:4px">No listing fee · No sales tax · Seller receives full asking price</div>
            <div style="margin-top:12px;display:flex;gap:8px;justify-content:center">
              <button data-action="ahListItem" ${(parseInt(ahSellPrice)||0) < 1 ? 'disabled' : ''}>🏛 List for Sale</button>
              <button class="secondary" data-action="ahCancelSell">Cancel</button>
            </div>
          </div>`;
        }
      }

      // ── MY LISTINGS TAB ──
      if (ahTab === 'my') {
        if (!ahMyListings) {
          html += `<div class="shop-empty">Loading your listings...</div>`;
          loadAhMyListings();
        } else if (ahMyListings.length === 0) {
          html += `<div class="shop-empty">You have no listings.</div>`;
        } else {
          html += `<div class="label" style="margin-bottom:8px">YOUR LISTINGS</div>`;
          html += ahMyListings.map(l => {
            const stateLabel = l.state === 'active' ? '' : l.state === 'sold' ? `<span class="ah-state-sold">✓ Sold to ${esc(l.buyerName)}</span>` : l.state === 'expired' ? '<span class="ah-state-expired">⏰ Expired</span>' : '<span class="ah-state-cancelled">Cancelled</span>';
            const totalPrice = l.price * l.quantity;
            return `<div class="ah-listing">
              <div class="ah-listing-info">
                <div class="ah-listing-name rarity-${l.itemRarity}">${esc(l.itemName)}${l.quantity>1?' ×'+l.quantity:''}</div>
                <div class="ah-listing-meta">${stateLabel || `Listed for ${totalPrice}g`}</div>
              </div>
              <div style="text-align:right">
                <div class="ah-listing-price">${totalPrice}g</div>
                ${l.state === 'active' ? `<button class="secondary small" data-action="ahCancel" data-id="${l.id}" data-num-id="1">Cancel</button>` : ''}
              </div>
            </div>`;
          }).join('');
        }
      }

      html += `<div style="margin-top:18px;text-align:center">
        <button class="secondary" data-action="leaveAuction">← Leave Auction House</button>
      </div>`;

      return html;
    }

    // Helper to get item definition from content (used in AH browse)
    function getItemDef(slug) {
      // Primary source: full item catalog from gameData (loaded at init from /api/fantasy/data)
      if (gameData.items?.[slug]) return gameData.items[slug];
      // Fallback: check inventory (has enriched data with perks)
      const fromInv = state.inventory?.find(i => i.slug === slug);
      if (fromInv) return fromInv;
      const fromShop = state.shop?.find(i => i.slug === slug);
      if (fromShop) return fromShop;
      return null;
    }

    function buildAbilityTags(a, c, rankOverride) {
      const rank = rankOverride || (c.ability_ranks || {})[a.slug] || 1;
      const rd = a.ranks?.[rank - 1] || {};
      const tags = [];
      tags.push(a.type);
      if (a.cost) tags.push(getAbilityRankCost(a.cost, (state.character?.ability_ranks||{})[a.slug]||1) + ' MP');
      const dispDmg = rd.damage || a.damage;
      if (dispDmg) tags.push(dispDmg + '× dmg');
      const totalHits = (a.hits || 1) + (rd.bonusHits || 0);
      if (a.aoe) tags.push('AoE' + (totalHits > 1 ? ' ' + totalHits + '×' : ''));
      else if (totalHits > 1) tags.push(totalHits + ' hits');
      if (a.stun) tags.push('stun');
      if (a.slow) tags.push('slow');
      if (a.dot) tags.push(a.dot.type + ' ' + a.dot.damage + '/t ×' + a.dot.turns);
      const dispHealPct = (rd.healPct || a.healPct || 0) + (rd.bonusHealPct || 0);
      if (dispHealPct) tags.push('heal ' + dispHealPct + '%');
      if (a.selfDamagePct) tags.push('self-dmg ' + a.selfDamagePct + '%');
      if (a.buff) {
        const bBonus = rd.buffBonus || 0;
        const dBonus = rd.durationBonus || 0;
        const sAmt = bBonus > 0 ? Math.floor(a.buff.amount * (1 + bBonus)) : a.buff.amount;
        const sDur = (a.buff.turns || 3) + dBonus;
        tags.push('+' + sAmt + ' ' + (a.buff.stat === 'all' ? 'all' : a.buff.stat === 'dodge' ? '% dodge' : (a.buff.stat||'').toUpperCase()) + ' ' + sDur + 't');
      }
      if (a.secondaryBuff) tags.push('+' + a.secondaryBuff.amount + ' ' + (a.secondaryBuff.stat||'').toUpperCase() + ' ' + a.secondaryBuff.turns + 't');
      if (a.statusEffect) tags.push(a.statusEffect.slug + ' ' + a.statusEffect.turns + 't');
      if (a.restore) {
        const restoreMul = 1 + (rd.restoreBonus || 0);
        tags.push('+' + Math.floor(a.restore * restoreMul) + ' MP');
      }
      if (a.restoreMp) tags.push('+' + a.restoreMp + ' MP');
      if (rd.bonusCritChance) tags.push('+' + rd.bonusCritChance + '% crit');
      if (rd.bonusDamageFlat) tags.push('+' + rd.bonusDamageFlat + ' flat dmg');
      if (rd.cleanse) tags.push('cleanse' + (rd.cleanse === 'all' ? ' all' : ' ×' + rd.cleanse));
      if (rd.shield) tags.push('shield ' + rd.shield + '% HP');
      if (rank > 1) tags.push('Rank ' + rank);
      return tags;
    }

    function buildNextRankPreview(a, currentRank) {
      if (currentRank >= 5 || !a.ranks?.[currentRank]) return '';
      const rd = a.ranks[currentRank - 1] || {};
      const nr = a.ranks[currentRank];
      const parts = [];
      if (nr.damage && nr.damage !== (rd.damage || a.damage)) parts.push(nr.damage + '× dmg');
      if (nr.healPct && nr.healPct !== (rd.healPct || a.healPct)) parts.push('heal ' + nr.healPct + '%');
      if (nr.bonusHealPct && nr.bonusHealPct !== (rd.bonusHealPct || 0)) parts.push('+' + nr.bonusHealPct + '% heal');
      if (nr.bonusCritChance && nr.bonusCritChance !== (rd.bonusCritChance||0)) parts.push('+' + nr.bonusCritChance + '% crit');
      if (nr.bonusDamageFlat && nr.bonusDamageFlat !== (rd.bonusDamageFlat||0)) parts.push('+' + nr.bonusDamageFlat + ' flat');
      if (nr.bonusHits && nr.bonusHits !== (rd.bonusHits||0)) parts.push('+' + (nr.bonusHits - (rd.bonusHits||0)) + ' hits');
      if (nr.cleanse && !rd.cleanse) parts.push('+ cleanse');
      if (nr.shield && !rd.shield) parts.push('+ shield');
      if (nr.durationBonus && nr.durationBonus !== (rd.durationBonus||0)) parts.push('+' + (nr.durationBonus-(rd.durationBonus||0)) + 't duration');
      if (nr.buffBonus && nr.buffBonus !== (rd.buffBonus||0)) parts.push('+' + Math.round((nr.buffBonus-(rd.buffBonus||0))*100) + '% strength');
      if (nr.restoreBonus && nr.restoreBonus !== (rd.restoreBonus||0)) parts.push('+' + Math.round((nr.restoreBonus-(rd.restoreBonus||0))*100) + '% MP restore');
      if (!parts.length) return '';
      return '<div style="font-size:.72rem;color:var(--muted);margin-top:3px">Next: ' + parts.join(', ') + '</div>';
    }

    function renderAcademyView() {
      const _academyTip = '';
      const c = state.character;
      const abils = state.abilities;
      if (!abils) return '<div class="shop-empty">No ability data.</div>';
      const tokens = c.arcane_tokens || 0;
      const currentModeLoadout = academyLoadoutMode === 'pvp' ? (abils.activePvp || abils.active) : academyLoadoutMode === 'raid' ? (abils.activeRaid || abils.active) : abils.active;
      const loadout = pendingLoadout || [...currentModeLoadout];
      const MAX_SLOTS = 6;
      const isPvp = academyLoadoutMode === 'pvp';
      const isRaid = academyLoadoutMode === 'raid';

      let html = _academyTip;

      // ── PvE / PvP / Raid mode toggle ──
      html += `<div style="display:flex;gap:4px;margin-bottom:12px;padding:3px;background:rgba(255,255,255,.04);border-radius:10px;border:1px solid var(--line);width:fit-content">
        <button class="${academyLoadoutMode === 'pve' ? '' : 'secondary'} small" data-action="setAcademyLoadoutMode" data-value="pve" style="border-radius:8px;min-width:70px;${academyLoadoutMode === 'pve' ? '' : 'box-shadow:none;border-color:transparent'}">⚔ PvE</button>
        <button class="${isPvp ? '' : 'secondary'} small" data-action="setAcademyLoadoutMode" data-value="pvp" style="border-radius:8px;min-width:70px;${isPvp ? 'background:linear-gradient(135deg,#6b1010,#8b2020);' : 'box-shadow:none;border-color:transparent'}">🏟 PvP</button>
        <button class="${isRaid ? '' : 'secondary'} small" data-action="setAcademyLoadoutMode" data-value="raid" style="border-radius:8px;min-width:70px;${isRaid ? 'background:linear-gradient(135deg,#0d6949,#14b8a6);' : 'box-shadow:none;border-color:transparent'}">🕳 Raid</button>
      </div>`;
      if (isPvp && !abils.pvpCustomized) {
        html += `<div class="gated-notice" style="margin-bottom:10px;border-color:rgba(139,32,32,.3);background:rgba(139,32,32,.06);color:#c44">⚠ No PvP loadout set yet — currently mirroring your PvE loadout. Save here to customize.</div>`;
      }
      if (isRaid && !abils.raidCustomized) {
        html += `<div class="gated-notice" style="margin-bottom:10px;border-color:rgba(20,184,166,.3);background:rgba(20,184,166,.06);color:#14b8a6">⚠ No Raid loadout set yet — currently mirroring your PvE loadout. Save here to customize for party raids.</div>`;
      }

      // ── Current loadout bar ──
      const modeLabel = isPvp ? 'PVP LOADOUT' : 'PVE LOADOUT';
      html += `<div class="label" style="margin-bottom:6px">${modeLabel} (${loadout.length}/${MAX_SLOTS})</div>`;
      html += `<div style="margin-bottom:10px;display:flex;flex-wrap:wrap;gap:0">`;
      if (loadout.length === 0) {
        html += `<span class="muted" style="font-size:.82rem;padding:4px 0">No abilities equipped. Select abilities below to add them.</span>`;
      } else {
        html += loadout.map((slug, idx) => {
          const a = abils.all.find(x => x.slug === slug);
          return `<div class="loadout-slot">
            <span style="color:var(--muted);font-size:.6rem;margin-right:2px">${idx+1}</span>
            <span class="ability-type-tag ${a?.type||''}">${(a?.type||'?').slice(0,4)}</span>
            ${esc(a?.name||slug)}
            <span class="remove-btn" data-action="removeFromLoadout" data-slug="${slug}">✕</span>
          </div>`;
        }).join('');
      }
      html += `</div>`;

      // Save / Reset
      const notCustomized = (isPvp && !abils.pvpCustomized) || (isRaid && !abils.raidCustomized);
      const changed = JSON.stringify(loadout) !== JSON.stringify(currentModeLoadout) || (notCustomized && pendingLoadout);
      if (changed) {
        const saveLabel = isPvp ? '💾 Save PvP Loadout' : isRaid ? '💾 Save Raid Loadout' : '💾 Save PvE Loadout';
        const saveClass = isPvp ? 'danger' : isRaid ? 'primary-action' : 'green';
        html += `<div style="margin-bottom:12px;display:flex;gap:8px;justify-content:center">
          <button class="${saveClass}" data-action="saveLoadout">${saveLabel}</button>
          <button class="secondary" data-action="resetLoadout">Reset</button>
        </div>`;
      }

      // ── All abilities (learned + available to learn) ──
      const allKnown = abils.all.filter(a => a.starter || abils.learned.includes(a.slug));
      const unlearnedAcademy = abils.all.filter(a => !a.starter && a.tokenCost && !abils.learned.includes(a.slug));
      const allAbilities = [...allKnown, ...unlearnedAcademy];

      // Type filter bar
      const types = ['all', ...new Set(allAbilities.map(a => a.type))];
      html += `<div class="talent-filter-bar">${types.map(t =>
        `<button class="${academyFilter === t ? '' : 'secondary'} small" data-action="setAcademyFilter" data-filter="${t}">${t === 'all' ? 'All' : t[0].toUpperCase() + t.slice(1)}</button>`
      ).join('')}</div>`;

      const filtered = academyFilter === 'all' ? allAbilities : allAbilities.filter(a => a.type === academyFilter);

      // ── Selected ability detail panel ──
      const sel = selectedTalent ? allAbilities.find(a => a.slug === selectedTalent) : null;
      if (sel) {
        const isLearned = sel.starter || abils.learned.includes(sel.slug);
        const isActive = loadout.includes(sel.slug);
        const canAdd = isLearned && !isActive && loadout.length < MAX_SLOTS;
        const selRank = (c.ability_ranks || {})[sel.slug] || 1;
        const tags = buildAbilityTags(sel, c);

        html += `<div class="talent-detail">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <div class="talent-detail-name"><span class="ability-type-tag ${sel.type}">${sel.type}</span> ${esc(sel.name)}${sel.starter ? ' <span style="font-size:.58rem;color:var(--emerald)">STARTER</span>' : !isLearned ? ' <span style="font-size:.58rem;color:#666">NOT LEARNED</span>' : ''}</div>
              <div class="talent-detail-desc">${esc(sel.description)}</div>
              <div class="talent-detail-tags">${tags.map(t => `<span class="talent-detail-tag">${esc(t)}</span>`).join('')}</div>
            </div>
            <div style="flex-shrink:0;margin-left:12px;text-align:right">
              ${!isLearned
                ? `<button class="small" data-action="learnAbility" data-slug="${sel.slug}" ${tokens >= sel.tokenCost ? '' : 'disabled'}>Learn (✦ ${sel.tokenCost})</button>`
                : isActive
                  ? `<div style="margin-bottom:4px"><span style="color:var(--emerald);font-size:.78rem;font-weight:600">✓ Slot ${loadout.indexOf(sel.slug)+1}</span></div>
                     <button class="secondary small" data-action="removeFromLoadout" data-slug="${sel.slug}" style="border-color:rgba(255,126,138,.3);color:var(--ember)">Remove</button>`
                  : `<button class="small" data-action="addToLoadout" data-slug="${sel.slug}" ${canAdd ? '' : 'disabled'}>${canAdd ? '+ Equip' : 'Loadout Full'}</button>`
              }
            </div>
          </div>
          ${isLearned ? (() => {
            const rank = selRank;
            const hardMax = 5;
            const questCap = classTrainerData?.maxAbilityRank || hardMax;
            const rankCosts = [0, 5, 10, 18, 30];
            const upgradeCost = rank < hardMax ? rankCosts[rank] : 0;
            const stars = Array.from({length: hardMax}, (_, i) => i < rank ? '★' : '☆').join('');
            const nextPreview = buildNextRankPreview(sel, rank);
            const atQuestCap = rank >= questCap && rank < hardMax;
            return `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">
              <div style="font-size:.82rem;color:var(--gold);margin-bottom:3px">Rank: ${stars} (${rank}/${hardMax})${questCap < hardMax ? ` <span class="muted" style="font-size:.72rem">· Cap: ${questCap} (class quests)</span>` : ''}</div>
              ${nextPreview}
              ${rank >= hardMax
                ? '<span style="color:var(--gold);font-size:.82rem;font-weight:600">✦ MAX RANK</span>'
                : atQuestCap
                  ? '<div style="font-size:.78rem;color:#fbbf24;margin-top:4px">🔒 Complete the next class quest to unlock Rank ' + (rank+1) + '</div>'
                  : `<button class="small" data-action="upgradeAbility" data-slug="${sel.slug}" ${tokens >= upgradeCost ? '' : 'disabled'} style="margin-top:4px">⬆ Rank ${rank+1} (${upgradeCost}✦)</button>`
              }
            </div>`;
          })() : ''}
        </div>`;
      }

      // ── Tier groups ──
      const tiers = [
        { label: 'Starter Abilities', filter: a => !!a.starter },
        { label: 'Tier I — Fundamentals', filter: a => !a.starter && a.tokenCost >= 1 && a.tokenCost <= 7 },
        { label: 'Tier II — Advanced', filter: a => !a.starter && a.tokenCost >= 8 && a.tokenCost <= 10 },
        { label: 'Tier III — Expert', filter: a => !a.starter && a.tokenCost >= 11 && a.tokenCost <= 14 },
        { label: 'Tier IV — Master', filter: a => !a.starter && a.tokenCost >= 15 },
      ];

      for (const tier of tiers) {
        const tierAbils = filtered.filter(tier.filter);
        if (tierAbils.length === 0) continue;
        html += `<div class="talent-tier">
          <div class="talent-tier-header"><span class="talent-tier-label">${tier.label}</span></div>
          <div class="talent-grid">
            ${tierAbils.map(a => {
              const isLearned = a.starter || abils.learned.includes(a.slug);
              const isActive = loadout.includes(a.slug);
              const isSelected = selectedTalent === a.slug;
              const aRank = (c.ability_ranks || {})[a.slug] || 1;
              const aRd = a.ranks?.[aRank - 1] || {};
              const totalHits = (a.hits || 1) + (aRd.bonusHits || 0);
              const rankStars = isLearned && aRank > 1 ? ' <span style="color:var(--gold);font-size:.65rem">' + '★'.repeat(aRank) + '</span>' : '';
              const cellClass = !isLearned ? 'is-locked' : isActive ? 'is-learned' : '';
              return `<div class="talent-cell ${cellClass}" data-action="selectTalent" data-slug="${a.slug}" style="${isSelected ? 'border-color:#9068d0;background:rgba(144,104,208,.06);box-shadow:0 0 8px rgba(192,132,252,.2)' : ''}">
                <div class="talent-cell-head">
                  <span class="ability-type-tag ${a.type}">${(a.type||'?').slice(0,4)}</span>
                  <span class="talent-cell-name">${esc(a.name)}${rankStars}</span>
                </div>
                <div class="talent-cell-meta">
                  <span class="talent-cell-mp">${getAbilityRankCost(a.cost, aRank)} MP</span>
                  ${a.aoe ? '<span class="talent-cell-mp" style="color:#5bc0de">AoE</span>' : totalHits > 1 ? '<span class="talent-cell-mp">' + totalHits + '×</span>' : ''}
                  <span class="talent-cell-status ${isActive ? 'learned' : !isLearned ? 'cost' : ''}">${isActive ? '✓ Slot ' + (loadout.indexOf(a.slug)+1) : !isLearned ? '✦ ' + a.tokenCost : ''}</span>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
      }
      if (filtered.length === 0) html += '<div class="shop-empty">No abilities found.</div>';

      return html;
    }

    function renderGuildView() {
      const _guildTip = '';
      const c = state.character;
      const g = state.guild;

      // Not registered — show registration prompt
      if (!g.registered) {
        return `
          <div style="text-align:center;padding:30px 0">
            <div class="eyebrow">⚔ ADVENTURER'S GUILD</div>
            <h3 style="margin:8px 0">Join the Guild</h3>
            <p class="muted" style="max-width:400px;margin:12px auto;font-size:.88rem">
              Register with the Adventurer's Guild to unlock daily bounties, earn Guild Marks,
              and access the exclusive Guild Vendor. Prove your worth across the realm.
            </p>
            <p style="font-size:1.1rem;margin:16px 0">Registration fee: <strong style="color:var(--gold)">${g.registrationCost}g</strong></p>
            <button data-action="guildRegister" ${c.gold < g.registrationCost ? 'disabled' : ''}>⚔ Register (${g.registrationCost}g)</button>
            <div style="margin-top:12px"><button class="secondary" data-action="leaveGuild">← Back</button></div>
          </div>`;
      }

      // Registered — show guild hub
      const rank = g.rankInfo;
      const xpPct = rank.nextRank ? Math.min(100, ((g.xp - rank.xpNeeded) / (rank.nextRank.xpNeeded - rank.xpNeeded)) * 100) : 100;

      let html = _guildTip + `
        <div class="guild-header">
          <div>
            <div class="eyebrow">⚔ ADVENTURER'S GUILD</div>
            <h3 style="margin:0">${esc(state.location?.name)}</h3>
          </div>
          <div style="text-align:right">
            <div class="guild-rank-badge">🎖 ${esc(rank.name)}</div>
            <div style="width:120px;margin-top:4px">
              <div class="guild-xp-bar"><div class="guild-xp-fill" style="width:${xpPct.toFixed(0)}%"></div></div>
              <div class="muted" style="font-size:.65rem;margin-top:2px">${g.xp} XP${rank.nextRank ? ' / ' + rank.nextRank.xpNeeded : ' (MAX)'}</div>
            </div>
          </div>
        </div>
        <div style="margin-bottom:8px;font-size:.82rem">
          <span style="color:#5882be">⚔ ${g.marks} Guild Marks</span> &nbsp;
          <span style="color:var(--gold)">💰 ${c.gold}g</span>
        </div>
        <div class="shop-tabs">
          <button class="shop-tab${guildTab==='bounties'?' active':''}" data-action="setGuildTab" data-tab="bounties">Bounty Board</button>
          <button class="shop-tab${guildTab==='active'?' active':''}" data-action="setGuildTab" data-tab="active">Active (${activeBounties ? activeBounties.length : '…'}/${maxActiveBounties})</button>
          <button class="shop-tab${guildTab==='vendor'?' active':''}" data-action="setGuildTab" data-tab="vendor">Guild Vendor</button>
        </div>`;

      if (guildTab === 'bounties') {
        if (!bountyBoard) {
          html += `<div class="shop-empty">Loading bounties...</div>`;
          loadBountyBoard();
        } else if (bountyBoard.length === 0) {
          html += `<div class="shop-empty">No bounties available today.</div>`;
        } else {
          html += `<div class="label" style="margin-bottom:8px">TODAY'S BOUNTIES</div>`;
          html += bountyBoard.map(b => {
            const pct = b.accepted ? Math.min(100, (b.kills / b.killTarget) * 100) : 0;
            let actionBtn = '';
            if (b.claimed) {
              actionBtn = `<span class="muted" style="font-size:.78rem">✓ Claimed</span>`;
            } else if (b.completed) {
              actionBtn = `<button class="green small" data-action="claimBounty" data-id="${b.id}" data-num-id="1">Claim Rewards</button>`;
            } else if (b.accepted) {
              actionBtn = `<span class="muted" style="font-size:.78rem">${b.kills}/${b.killTarget} kills</span>`;
            } else {
              const atLimit = activeBounties && activeBounties.length >= maxActiveBounties;
              actionBtn = atLimit
                ? `<span class="muted" style="font-size:.72rem">At limit (${maxActiveBounties}/${maxActiveBounties})</span>`
                : `<button class="small" data-action="acceptBounty" data-id="${b.id}" data-num-id="1">Accept</button>`;
            }
            return `<div class="bounty-card ${b.tier}${b.completed?' completed':''}${b.claimed?' claimed':''}">
              <div style="display:flex;justify-content:space-between;align-items:flex-start">
                <div>
                  <span class="bounty-tier ${b.tier}">${b.tier}</span>
                  <div class="bounty-target">Kill ${b.killTarget}× ${esc(b.enemyName)}</div>
                  <div class="bounty-area">📍 ${esc(b.areaName)}</div>
                </div>
                <div style="text-align:right">
                  ${actionBtn}
                </div>
              </div>
              <div class="bounty-rewards">
                <span style="color:var(--gold)">💰 ${b.rewardGold}g</span>
                <span style="color:#5882be">⚔ ${b.rewardGuildMarks}</span>
                <span style="color:#9068d0">+${b.guildXp} Guild XP</span>
              </div>
              ${b.accepted && !b.claimed ? `<div class="bounty-progress">
                <div class="bounty-progress-bar"><div class="bounty-progress-fill" style="width:${pct}%"></div></div>
              </div>` : ''}
            </div>`;
          }).join('');
        }
      }

      if (guildTab === 'active') {
        if (!activeBounties) {
          html += `<div class="shop-empty">Loading active bounties...</div>`;
          loadBountyBoard(); // this also loads activeBounties
        } else if (activeBounties.length === 0) {
          html += `<div class="shop-empty">No active bounties. Accept some from the Bounty Board!</div>`;
        } else {
          html += `<div class="label" style="margin-bottom:8px">ACTIVE BOUNTIES (${activeBounties.length}/${maxActiveBounties})</div>`;
          html += activeBounties.map(b => {
            const pct = Math.min(100, (b.kills / b.killTarget) * 100);
            let actionBtn = '';
            if (b.completed) {
              actionBtn = `<button class="green small" data-action="claimBounty" data-id="${b.id}" data-num-id="1">Claim</button>`;
            } else {
              actionBtn = `<span class="muted" style="font-size:.78rem">${b.kills}/${b.killTarget}</span>`;
            }
            return `<div class="bounty-card ${b.tier}${b.completed?' completed':''}">
              <div style="display:flex;justify-content:space-between;align-items:flex-start">
                <div>
                  <span class="bounty-tier ${b.tier}">${b.tier}</span>
                  <div class="bounty-target">Kill ${b.killTarget}× ${esc(b.enemyName)}</div>
                  <div class="bounty-area">📍 ${esc(b.areaName)}</div>
                </div>
                <div style="text-align:right;display:flex;flex-direction:column;gap:4px;align-items:flex-end">
                  ${actionBtn}
                  <button class="small secondary" data-action="abandonBounty" data-id="${b.id}" data-num-id="1" style="font-size:.7rem;padding:2px 8px">✕ Abandon</button>
                </div>
              </div>
              <div class="bounty-rewards">
                <span style="color:var(--gold)">💰 ${b.rewardGold}g</span>
                <span style="color:#5882be">⚔ ${b.rewardGuildMarks}</span>
                <span style="color:#9068d0">+${b.guildXp} Guild XP</span>
              </div>
              <div class="bounty-progress">
                <div class="bounty-progress-bar"><div class="bounty-progress-fill" style="width:${pct}%"></div></div>
              </div>
            </div>`;
          }).join('');
        }
      }

      if (guildTab === 'vendor') {
        if (!guildVendorStock) {
          html += `<div class="shop-empty">Loading vendor...</div>`;
          loadGuildVendor();
        } else if (guildVendorStock.length === 0) {
          html += `<div class="shop-empty">No items available at your current rank.</div>`;
        } else {
          html += `<div class="label" style="margin-bottom:8px">GUILD VENDOR</div>`;
          html += guildVendorStock.map(item => `<div class="shop-row">
            <div class="shop-row-info">
              <div class="shop-row-name">${esc(item.name)}</div>
              <div class="shop-row-meta">${esc(item.description)} <span class="muted">(Rank ${item.minRank}+)</span></div>
            </div>
            <div class="shop-row-price" style="color:#5882be">⚔ ${item.cost}</div>
            <button class="small" data-action="guildBuy" data-slug="${item.slug}" ${g.marks < item.cost ? 'disabled' : ''}>Buy</button>
          </div>`).join('');
        }
      }

      html += `<div style="margin-top:18px;text-align:center">
        <button class="secondary" data-action="leaveGuild">← Leave Guild Hall</button>
      </div>`;

      return html;
    }

    function renderHomeView() {
      const allRecipes = [...(state.home?.recipes || [])].sort((a, b) => {
        if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
        if (a.canCraft !== b.canCraft) return a.canCraft ? -1 : 1;
        return (a.unlockLevel || 1) - (b.unlockLevel || 1);
      });
      const stash = state.home?.storage || [];
      const recipeScrolls = state.home?.recipeScrolls || [];
      const recipes = homeRecipeFilter === 'all' ? allRecipes : allRecipes.filter(recipe => (recipe.category || 'other') === homeRecipeFilter);
      const recipeBook = state.home?.recipeBook || [];
      const ingredientBook = state.home?.ingredientBook || [];
      const isHome = state.home?.isAtHome;
      const locName = state.location?.name || 'Workshop';
      let html = `
        <div class="market-header">
          <div>
            <div class="eyebrow">${isHome ? '🏠 HOME' : '🔨 WORKSHOP & FORGE'}</div>
            <h3 style="margin:0">${isHome ? 'Thornwall Cottage' : esc(locName) + ' Workshop'}</h3>
            <div class="muted" style="margin-top:4px">${isHome ? 'Store your haul, sort your supplies, and turn hard-won materials into gear and consumables.' : 'Craft gear and enchant equipment. Home storage is at Thornwall.'}</div>
          </div>
          ${isHome ? `<div class="market-gold">Stash ${state.home?.storageUsed || 0}/${state.home?.storageCapacity || 0}</div>` : ''}
        </div>`;

      if (isHome) {
        html += `<div class="item" style="margin-bottom:14px">
          <div class="item-head"><strong>Storage Capacity</strong><span class="mono muted" style="font-size:.78rem">${state.home?.storageRemaining || 0} slots free</span></div>
          <div class="muted" style="margin-top:6px;font-size:.88rem">Base cottage storage grows through gold upgrades and village renown from completed quests.</div>
          <div class="mono muted" style="margin-top:8px;font-size:.76rem">Gold upgrades: +${state.home?.goldStorageBonus || 0} slots · Quest renown: +${state.home?.questStorageBonus || 0} slots</div>
          <div class="item-actions"><button class="small" data-action="upgradeHome" ${state.character.gold < (state.home?.upgradeCost || 0) ? 'disabled' : ''}>Expand Storage (${state.home?.upgradeCost || 0}g)</button></div>
        </div>`;
      }

      const atHome = state.home?.isAtHome;
      html += `<div class="tab-bar" style="margin-bottom:16px">
        <button class="tab-btn ${homeTab === 'crafting' ? 'active' : ''}" data-action="setHomeTab" data-tab="crafting">Crafting</button>
        <button class="tab-btn ${homeTab === 'forge' ? 'active' : ''}" data-action="setHomeTab" data-tab="forge">⚒ Forge</button>
        ${atHome ? `<button class="tab-btn ${homeTab === 'inventory' ? 'active' : ''}" data-action="setHomeTab" data-tab="inventory">📦 Stash</button>` : ''}
        ${atHome ? `<button class="tab-btn ${homeTab === 'vault' ? 'active' : ''}" data-action="setHomeTab" data-tab="vault">📦 Vault</button>` : ''}
      </div>`;

      if (homeTab === 'forge') {
        html += renderForgeView();
      }

      if (homeTab === 'vault') {
        const vault = state.vault || { items: [], used: 0, capacity: 20 };
        html += `<div class="eyebrow">ACCOUNT VAULT <span class="muted" style="font-weight:400">(${vault.used}/${vault.capacity})</span></div>`;
        html += `<div class="muted" style="font-size:.8rem;margin-bottom:12px">Shared across all your characters. Transfer items between alts.</div>`;
        html += `<div class="ah-panels" style="min-height:320px">`;
        // Left: vault items
        html += `<div class="ah-item-list" style="max-height:420px">`;
        if (vault.items.length) {
          html += vault.items.map(item => {
            const hasPerks = item.perks && item.perks.length > 0;
            return `<div class="ah-list-item${hasPerks ? ' inv-perked' : ''}" style="cursor:default">
              <span class="ali-slot">${esc(item.type||'')}</span>
              <span class="ali-name rarity-${item.rarity}">${hasPerks ? '✦ ' : ''}${esc(item.name)}${item.quantity>1?' <span class="muted">×'+item.quantity+'</span>':''}</span>
              <button class="small" style="margin-left:auto;padding:2px 8px;font-size:.68rem" data-action="vaultWithdraw" data-slug="${item.item_slug}" data-vault-id="${item.id || ''}" data-qty="${item.quantity}">Take</button>
            </div>`;
          }).join('');
        } else {
          html += `<div style="padding:20px;text-align:center;color:var(--muted);font-style:italic">Vault is empty. Store items from your inventory.</div>`;
        }
        html += `</div>`;
        // Right: character inventory (for storing into vault)
        html += `<div class="ah-detail" style="max-height:420px">`;
        html += `<div class="label" style="margin-bottom:8px">YOUR INVENTORY</div>`;
        const vaultableItems = state.inventory.filter(i => i.type !== 'recipe');
        if (vaultableItems.length) {
          html += vaultableItems.map(item => {
            const hasPerks = item.perks && item.perks.length > 0;
            return `<div class="ah-list-item${hasPerks ? ' inv-perked' : ''}" style="cursor:default">
              <span class="ali-slot">${esc(item.type||'')}</span>
              <span class="ali-name rarity-${item.rarity}">${hasPerks ? '✦ ' : ''}${esc(item.name)}${item.quantity>1?' <span class="muted">×'+item.quantity+'</span>':''}</span>
              <button class="small" style="margin-left:auto;padding:2px 8px;font-size:.68rem" data-action="vaultStore" data-slug="${item.slug}" data-inventory-id="${item.inventoryId || ''}" data-qty="${item.quantity}">Store</button>
            </div>`;
          }).join('');
        } else {
          html += `<div style="padding:20px;text-align:center;color:var(--muted);font-style:italic">No items to store.</div>`;
        }
        html += `</div></div>`;
      }

      if (homeTab === 'inventory') {
        // Store All Materials button
        const storableMats = state.inventory.filter(i => i.type === 'material' || i.type === 'gem' || i.type === 'crystal');
        if (storableMats.length > 0) {
          const matCount = storableMats.reduce((s, i) => s + (i.quantity || 1), 0);
          html += `<div style="margin-bottom:12px"><button class="secondary small" data-action="storeAllMaterials">📦 Store All Materials & Gems (${matCount} items)</button></div>`;
        }

        // Three-panel: stash | detail | pack
        const stashKey = (item) => item.inventoryId ? 'stash-' + item.inventoryId : 'stash-' + item.slug;
        const packKey = (item) => item.inventoryId ? 'pack-' + item.inventoryId : 'pack-' + item.slug;
        if (!homeInvSelected) {
          if (stash.length) homeInvSelected = stashKey(stash[0]);
          else if (state.inventory.length) homeInvSelected = packKey(state.inventory[0]);
        }
        let selItem = null, selSource = null;
        if (homeInvSelected?.startsWith('stash-')) {
          const key = homeInvSelected.slice(6);
          selItem = stash.find(i => (i.inventoryId ? '' + i.inventoryId : i.slug) === key);
          selSource = 'stash';
        } else if (homeInvSelected?.startsWith('pack-')) {
          const key = homeInvSelected.slice(5);
          selItem = state.inventory.find(i => (i.inventoryId ? '' + i.inventoryId : i.slug) === key);
          selSource = 'pack';
        }

        html += `<div style="display:grid;grid-template-columns:1fr 1.3fr 1fr;gap:12px;min-height:380px">`;

        // Left: STASH
        html += `<div><div class="label" style="margin-bottom:6px">STASH <span class="muted" style="font-weight:400">(${state.home?.storageUsed || 0}/${state.home?.storageCapacity || 0})</span></div>`;
        html += `<div class="ah-item-list" style="max-height:450px">`;
        if (stash.length) {
          html += stash.map(item => {
            const key = stashKey(item);
            const isSel = key === homeInvSelected;
            const hasPerks = item.perks?.length > 0;
            return `<div class="ah-list-item${isSel ? ' selected' : ''}${hasPerks ? ' inv-perked' : ''}" data-action="selectHomeInvItem" data-id="${key}">
              <span class="ali-slot">${esc(item.type||'')}</span>
              <span class="ali-name rarity-${item.rarity}">${hasPerks ? '✦ ' : ''}${esc(item.name)}${item.quantity>1?' <span class="muted">×'+item.quantity+'</span>':''}</span>
            </div>`;
          }).join('');
        } else {
          html += `<div style="padding:16px;text-align:center;color:var(--muted);font-style:italic">Stash is empty.</div>`;
        }
        html += `</div></div>`;

        // Center: DETAIL
        html += `<div class="ah-detail" style="max-height:480px">`;
        if (selItem) {
          const equipped = EQUIP_SLOTS.includes(getItemEquipSlot(selItem)) ? getEquippedItemFor(selItem) : null;
          const compareStats = equipped?.stats || null;
          html += `
            <div class="eyebrow" style="margin-bottom:4px">${esc(selItem.type||'').toUpperCase()}</div>
            <h3 style="margin:0 0 4px"><span class="rarity-${selItem.rarity}">${esc(selItem.name)}</span>${selItem.quantity>1?' <span class="muted" style="font-size:.85rem">×'+selItem.quantity+'</span>':''}</h3>
            <div class="mono muted" style="font-size:.8rem">${selItem.rarity}${selItem.sell ? ' · Sells for ' + selItem.sell + 'g' : ''}</div>
            ${selItem.description ? '<div class="muted" style="font-size:.88rem;margin-top:6px">' + esc(selItem.description) + '</div>' : ''}
            ${renderStatSummary(selItem.stats || {}, { compareStats })}
            ${renderItemEffectSummary(selItem)}
            ${renderPerks(selItem.perks)}
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">
              ${selSource === 'stash' ? `<button class="secondary small" data-action="withdrawItemPrompt" data-item-slug="${selItem.slug}" data-qty="${selItem.quantity}">← Withdraw to Pack</button>` : ''}
              ${selSource === 'pack' && selItem.type === 'recipe' ? `<button class="violet small" data-action="learnRecipe" data-slug="${selItem.slug}">Study Recipe</button>` : ''}
              ${selSource === 'pack' && selItem.type !== 'recipe' ? `<button class="small" data-action="storeItemPrompt" data-item-slug="${selItem.slug}" data-qty="${selItem.quantity}">Store in Stash →</button>` : ''}
            </div>`;
        } else {
          html += `<div class="ah-detail-empty">Select an item to view details</div>`;
        }
        html += `</div>`;

        // Right: PACK
        html += `<div><div class="label" style="margin-bottom:6px">PACK <span class="muted" style="font-weight:400">(${state.inventory.length} stacks)</span></div>`;
        html += `<div class="ah-item-list" style="max-height:450px">`;
        if (state.inventory.length) {
          html += state.inventory.map(item => {
            const key = packKey(item);
            const isSel = key === homeInvSelected;
            const hasPerks = item.perks?.length > 0;
            return `<div class="ah-list-item${isSel ? ' selected' : ''}${hasPerks ? ' inv-perked' : ''}" data-action="selectHomeInvItem" data-id="${key}">
              <span class="ali-slot">${esc(item.type||'')}</span>
              <span class="ali-name rarity-${item.rarity}">${hasPerks ? '✦ ' : ''}${esc(item.name)}${item.quantity>1?' <span class="muted">×'+item.quantity+'</span>':''}</span>
            </div>`;
          }).join('');
        } else {
          html += `<div style="padding:16px;text-align:center;color:var(--muted);font-style:italic">Pack is empty.</div>`;
        }
        html += `</div></div>`;

        html += `</div>`;
      }

      if (homeTab === 'crafting') {
        if (recipeScrolls.length) {
          html += `<div class="market-section"><div class="label">UNREAD RECIPE SCROLLS</div><div class="cards" style="margin-top:8px">${recipeScrolls.map(item => `<div class="item">
            <div class="item-head"><strong>${renderRarityName(item)}</strong><span class="mono rarity-${item.rarity}" style="font-size:.75rem">Scroll</span></div>
            <div class="muted" style="margin-top:4px;font-size:.85rem">${esc(item.description || '')}</div>
            <div class="item-actions"><button class="violet small" data-action="learnRecipe" data-slug="${item.slug}">Study Scroll</button></div>
          </div>`).join('')}</div></div>`;
        }

        // Build dynamic category list from actual recipes
        const recipeCats = ['all', ...new Set(allRecipes.map(r => r.category || 'other').filter(Boolean))].sort((a,b) => a === 'all' ? -1 : b === 'all' ? 1 : a.localeCompare(b));
        const catLabels = { all:'All', consumable:'Consumable', weapon:'Weapon', armor:'Armor', shield:'Shield', body:'Body', helmet:'Helmet', gloves:'Gloves', boots:'Boots', amulet:'Amulet', ring:'Ring', trinket:'Trinket', accessory:'Accessory', legendary:'Legendary', other:'Other' };

        html += `<div class="market-section"><div class="label">CRAFTING BENCH</div>
          <div class="shop-filters" style="margin:10px 0 12px">
            ${recipeCats.map(cat => `<button class="${homeRecipeFilter === cat ? '' : 'secondary'} small" data-action="setHomeRecipeFilter" data-filter="${cat}">${catLabels[cat] || cat[0].toUpperCase() + cat.slice(1)}</button>`).join('')}
          </div>`;

        // Recipe list + detail below (single-column, scrollable like shop)
        const selRecipe = recipes.find(r => r.slug === selectedRecipeSlug) || null;
        if (selRecipe && craftQty > (selRecipe.maxCraftable || 0)) craftQty = Math.max(1, selRecipe.maxCraftable || 1);

        // Detail pane (shown above list when a recipe is selected)
        if (selRecipe) {
          const lockText = !selRecipe.unlockedByLevel ? `Unlocks at Lv ${selRecipe.unlockLevel}` : (!selRecipe.known && selRecipe.requiresDiscovery ? 'Recipe undiscovered' : `Can craft up to ${selRecipe.maxCraftable}`);
          html += `<div style="padding:12px 14px;border:1px solid rgba(214,176,95,.25);border-radius:12px;background:rgba(214,176,95,.04);margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <div class="eyebrow" style="margin-bottom:4px">${esc(selRecipe.category || 'craft').toUpperCase()}</div>
                <h3 style="margin:0 0 4px">${renderRarityName(selRecipe.output, selRecipe.name)}</h3>
                <div class="muted" style="font-size:.85rem">${esc(selRecipe.description || '')}</div>
                <div class="mono muted" style="margin-top:6px;font-size:.74rem">${esc(lockText)}${selRecipe.requiresDiscovery && selRecipe.known ? ' · Discovered' : ''}</div>
              </div>
              <button class="secondary small" data-action="selectRecipe" data-slug="" style="flex-shrink:0">✕</button>
            </div>
            ${renderStatSummary(selRecipe.output?.stats)}
            ${renderItemEffectSummary(selRecipe.output)}
            <div class="label" style="margin:10px 0 6px">INGREDIENTS${craftQty > 1 ? ' (×' + craftQty + ')' : ''}</div>
            ${(selRecipe.ingredients || []).map(ing => {
              const needed = ing.qty * craftQty;
              const met = ing.total >= needed;
              return `<div class="ingredient-row ${met ? 'ready' : 'missing'}">
                <span>${renderRarityName({ name: ing.name, rarity: ing.rarity })} ×${needed}</span>
                <span class="mono">${ing.total} have (${ing.inPack} pack / ${ing.inStorage} stash)</span>
              </div>`;
            }).join('')}
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:10px">
              <div class="qty-stepper">
                <button data-action="setCraftQty" data-qty="${Math.max(1, craftQty - 1)}">−</button>
                <span class="qty-val">${craftQty}</span>
                <button data-action="setCraftQty" data-qty="${Math.min(selRecipe.maxCraftable || 1, craftQty + 1)}">+</button>
              </div>
              <button class="secondary small" data-action="setCraftQty" data-qty="${selRecipe.maxCraftable || 1}">Max (${selRecipe.maxCraftable || 0})</button>
              <button class="green" data-action="craftItem" data-recipe="${selRecipe.slug}" data-qty="${craftQty}" ${selRecipe.canCraft && craftQty > 0 && craftQty <= selRecipe.maxCraftable ? '' : 'disabled'}>Craft${craftQty > 1 ? ' ×' + craftQty : ''}</button>
            </div>
          </div>`;
        }

        // Scrollable recipe list
        if (recipes.length) {
          html += `<div style="max-height:400px;overflow-y:auto;border:1px solid var(--line);border-radius:10px;padding:4px">`;
          html += recipes.map(recipe => {
            const isSel = recipe.slug === selectedRecipeSlug;
            const statusIcon = !recipe.unlocked ? '🔒' : recipe.canCraft ? '✅' : '⚠';
            const statusColor = !recipe.unlocked ? 'var(--muted)' : recipe.canCraft ? 'var(--emerald)' : '#fbbf24';
            const outStats = recipe.output?.stats;
            const statLine = outStats ? Object.entries(outStats).filter(([,v])=>v).map(([k,v]) => `${v>0?'+':''}${v} ${k.toUpperCase()}`).join(' · ') : '';
            return `<div class="shop-row" data-action="selectRecipe" data-slug="${recipe.slug}" style="cursor:pointer;${isSel ? 'border-color:var(--gold);background:rgba(214,176,95,.06)' : ''}${!recipe.unlocked ? ';opacity:.45' : ''}">
              <div style="font-size:.82rem;min-width:20px;text-align:center;color:${statusColor}">${statusIcon}</div>
              <div class="shop-row-slot">${esc(recipe.category || '?')}</div>
              <div class="shop-row-info">
                <div class="shop-row-name rarity-${esc(recipe.output?.rarity || 'common')}">${esc(recipe.name)}</div>
                <div class="shop-row-meta">${statLine || esc(recipe.description || '')}</div>
              </div>
              <div class="muted" style="font-size:.68rem;white-space:nowrap">${recipe.canCraft ? 'Can craft ×' + (recipe.maxCraftable||0) : !recipe.unlocked ? 'Locked' : 'Missing mats'}</div>
            </div>`;
          }).join('');
          html += `</div>`;
        } else {
          html += `<div style="padding:16px;color:var(--muted);text-align:center;font-style:italic">No recipes match this filter.</div>`;
        }
        html += `</div>`; // end market-section
      }

      html += `<div style="margin-top:18px;text-align:center">
        <button class="secondary" data-action="leaveHome">← Leave Home</button>
      </div>`;

      return html;
    }

    // ══════════════════════════════════════════
    //  NAVIGATION PANEL (right sidebar)
    // ══════════════════════════════════════════
    function threatClass(threat, charLevel) {
      if (threat <= charLevel) return 'safe';
      if (threat <= charLevel + 2) return 'caution';
      return 'danger';
    }
    function threatLabel(threat, charLevel) {
      const cls = threatClass(threat, charLevel);
      if (cls === 'safe') return 'Safe';
      if (cls === 'caution') return 'Caution';
      return 'Dangerous';
    }
    function threatIcon(cls) {
      if (cls === 'safe') return '🛡';
      if (cls === 'caution') return '⚠';
      return '💀';
    }

    function renderNavPanel() {
      const c = state.character;
      const loc = state.location;
      const inCombat = c.in_combat;
      const threats = state.locationThreat || {};
      const allLocations = state.locations || [];
      const currentSlug = c.location;
      const allBounties = state.guild?.allActiveBounties || [];
      const realms = gameData.realms || [];
      const unlockedRealms = state.unlockedRealms || ['ashlands'];
      const currentRealm = miniMapRealm || state.currentRealm || 'ashlands';
      // Reset miniMapRealm if viewing the realm we're in
      if (miniMapRealm === (state.currentRealm || 'ashlands')) miniMapRealm = null;

      // Build bounty map: areaSlug → count of active bounties
      const bountyByArea = {};
      for (const b of allBounties) {
        bountyByArea[b.areaSlug] = (bountyByArea[b.areaSlug] || 0) + 1;
      }

      // Get graph layout for current realm
      const { positions, portalNodes } = getRealmLayout(currentRealm, allLocations, realms, unlockedRealms);
      const realmLocs = allLocations.filter(l => (l.realm || 'ashlands') === currentRealm);
      const allMapNodes = [...realmLocs, ...portalNodes];

      // Build adjacency for edges (realm-scoped)
      const edgeSet = new Set();
      const edges = [];
      for (const l of allMapNodes) {
        for (const conn of (l.connections || [])) {
          if (!positions.has(conn)) continue; // skip cross-realm connections
          const key = [l.slug, conn].sort().join('|');
          if (!edgeSet.has(key)) { edgeSet.add(key); edges.push([l.slug, conn]); }
        }
      }

      // SVG edges
      let svgEdges = '';
      const currentConns = new Set(loc?.connections || []);
      for (const [a, b] of edges) {
        const pa = positions.get(a);
        const pb = positions.get(b);
        if (!pa || !pb) continue;
        const isActive = (a === currentSlug && currentConns.has(b)) || (b === currentSlug && currentConns.has(a));
        const isPortal = a.startsWith('_portal_') || b.startsWith('_portal_');
        svgEdges += `<line x1="${pa.x}%" y1="${pa.y}%" x2="${pb.x}%" y2="${pb.y}%" class="minimap-edge${isActive ? ' mm-active' : ''}${isPortal ? ' mm-portal' : ''}" />`;
      }

      // Map nodes (compact icon-only with hover tooltips)
      const adjacentSlugs = new Set(loc?.connections || []);
      let nodesHtml = '';
      for (const l of allMapNodes) {
        const pos = positions.get(l.slug);
        if (!pos) continue;
        const isPortal = l.slug.startsWith('_portal_');
        const isCurrent = l.slug === currentSlug;
        const isAdjacent = adjacentSlugs.has(l.slug);
        const threat = threats[l.slug] || 1;
        const tCls = threatClass(threat, c.level);
        const hasBounty = bountyByArea[l.slug] > 0;
        const disabled = (inCombat && !isCurrent) || isPortal;

        let cls = 'mm-node';
        if (isCurrent) cls += ' mm-current';
        else if (isPortal) cls += ' mm-portal-node';
        else if (isAdjacent) cls += ' mm-adjacent';
        if (disabled) cls += ' mm-disabled';

        let action = '';
        if (isPortal && l.portalTarget) {
          action = `data-action="switchMiniRealm" data-value="${l.portalTarget}"`;
          cls = cls.replace(' mm-disabled', '');
        } else if (!isCurrent && !disabled) {
          action = `data-action="travelPath" data-dest="${l.slug}"`;
        }

        const tooltipMeta = isPortal ? 'Portal' : `${l.type} · Lv ${threat} · ${threatLabel(threat, c.level)}`;

        nodesHtml += `
          <div class="${cls}" ${action} style="left:${pos.x}%;top:${pos.y}%">
            ${hasBounty ? '<span class="mm-bounty-badge">⚔</span>' : ''}
            ${locIcon(l.type)}
            <div class="mm-tooltip">
              <span class="mm-tooltip-name">${esc(l.name)}</span>
              <span class="mm-tooltip-meta wm-threat-${tCls}">${isCurrent ? '📍 You are here' : tooltipMeta}</span>
            </div>
          </div>`;
      }

      // Realm header with arrows
      const realmObj = realms.find(r => r.slug === currentRealm);
      const realmName = realmObj ? `${realmObj.icon} ${realmObj.name}` : currentRealm;
      const realmIdx = realms.findIndex(r => r.slug === currentRealm);
      const prevRealm = unlockedRealms.length > 1 ? realms.filter(r => unlockedRealms.includes(r.slug) && r.order < (realmObj?.order || 1)).pop() : null;
      const nextRealm = unlockedRealms.length > 1 ? realms.find(r => unlockedRealms.includes(r.slug) && r.order > (realmObj?.order || 1)) : null;

      // ── MINI-MAP ──
      let html = `
        <div class="minimap-realm-bar">
          ${prevRealm ? `<button class="minimap-realm-arrow" data-action="switchMiniRealm" data-value="${prevRealm.slug}" title="${esc(prevRealm.name)}">◀</button>` : '<span class="minimap-realm-arrow-placeholder"></span>'}
          <span class="minimap-realm-label">${esc(realmName)}</span>
          ${nextRealm ? `<button class="minimap-realm-arrow" data-action="switchMiniRealm" data-value="${nextRealm.slug}" title="${esc(nextRealm.name)}">▶</button>` : '<span class="minimap-realm-arrow-placeholder"></span>'}
        </div>
        <div class="minimap-wrap">
          <button class="minimap-expand" data-action="openWorldMap" title="Expand map">⛶</button>
          <svg class="minimap-svg" xmlns="http://www.w3.org/2000/svg">${svgEdges}</svg>
          ${nodesHtml}
        </div>`;

      // ── LOCATION INFO ──
      const curThreat = threats[currentSlug] || 1;
      const tCls = threatClass(curThreat, c.level);

      html += `<div class="loc-info">`;
      html += `<div class="loc-info-header">
        <span style="font-size:1.1rem">${locIcon(loc?.type)}</span>
        <span class="loc-info-name">${esc(loc?.name || currentSlug)}</span>
        <span class="loc-info-type nav-loc-type ${locTypeClass(loc?.type)}">${esc(loc?.type || 'unknown')}</span>
        <span class="mm-node-threat wm-threat-${tCls}" style="margin-left:auto">${threatIcon(tCls)} Lv ${curThreat}</span>
      </div>`;

      // Services (towns)
      if (loc?.type === 'town') {
        const isThorn = currentSlug === 'thornwall';
        const isIron = currentSlug === 'ironhold';
        const isSun = currentSlug === 'sunspire';
        const services = [
          { icon: '🏪', label: 'Shop', active: !!state.shop },
          { icon: '🏨', label: 'Inn', active: !!state.inn },
          { icon: '⚔', label: 'Guild', active: !!state.guild?.hasBountyBoard },
          { icon: '🏛', label: 'Auction', active: !!state.hasAuctionHouse },
          { icon: '🏟', label: 'Arena', active: !!state.hasArena },
          { icon: '📚', label: 'Academy', active: isSun },
          { icon: '⚔', label: 'Class Trainer', active: state.hasClassTrainer },
          { icon: '🔥', label: 'Forge', active: isThorn },
          { icon: '🏠', label: 'Home', active: isThorn },
        ];
        html += `<div class="loc-services">${services.map(s =>
          `<span class="loc-service${s.active ? '' : ' svc-inactive'}">${s.icon} ${s.label}</span>`
        ).join('')}</div>`;
      }

      // Dungeon info
      if (loc?.type === 'dungeon') {
        const dc = state.dungeonConfig;
        const ds = state.dungeonState;
        if (dc) {
          html += `<div style="font-size:.8rem;margin-bottom:6px"><span class="muted">Boss:</span> <strong>${esc(dc.bossName || dc.boss || 'Unknown')}</strong></div>`;
          html += `<div style="font-size:.75rem;color:var(--muted)">${dc.minRooms}-${dc.maxRooms} rooms</div>`;
        }
        if (ds) {
          html += `<div style="font-size:.8rem;margin-top:4px;color:var(--gold)">⚔ Dungeon run: Room ${ds.roomsCleared + 1} / ${ds.totalRooms}</div>`;
        }
      }

      // Wild zone info
      if (loc?.type === 'wild') {
        const zoneEnemies = state.locationEnemyRange;
        html += `<div style="font-size:.75rem;color:var(--muted);margin-bottom:4px">Enemy zone · Explore to fight</div>`;
      }

      // Active bounties (ALL, not just current location)
      if (allBounties.length > 0) {
        html += `<div class="loc-bounty-list"><div class="label" style="margin-bottom:4px">ACTIVE BOUNTIES</div>`;
        for (const b of allBounties) {
          const isHere = b.areaSlug === currentSlug;
          html += `<div class="loc-bounty" ${isHere ? 'style="border-color:rgba(184,134,11,.3)"' : ''}>
            <span class="loc-bounty-tier ${b.tier}">${b.tier}</span>
            <span style="font-size:.72rem;flex:1">${esc(b.enemyName)} <span class="muted">· ${esc(b.areaName)}</span></span>
            <span class="loc-bounty-progress">${b.kills}/${b.killTarget}</span>
          </div>`;
        }
        html += `</div>`;
      }

      // Quick actions
      html += `<div class="loc-actions" style="gap:6px">`;
      if (c.location !== 'thornwall' && !inCombat) {
        html += `<button class="nav-home-btn" data-action="travelHome" style="flex:1;margin:0">🏠 Home</button>`;
      }
      html += `<button class="nav-home-btn" data-action="openFriends" style="flex:0;margin:0;min-width:40px;padding:4px 8px" title="Friends List">👥</button>`;
      html += `</div>`;

      html += `</div>`; // end loc-info

      $('navPanel').innerHTML = html;
    }

    // ══════════════════════════════════════════
    //  RENDER GAME — orchestrator
    // ══════════════════════════════════════════
    function renderGame() {
      $('createView').classList.add('hidden');
      $('gameView').classList.remove('hidden');
      $('topbar').classList.add('hidden');
      const c = state.character;
      const s = state.stats;
      const hpPct = Math.max(0, Math.min(100, (c.hp / c.max_hp) * 100));
      const mpPct = Math.max(0, Math.min(100, (c.mp / c.max_mp) * 100));
      const xpPct = Math.max(0, Math.min(100, (c.xp / state.xpNeeded) * 100));

      updateStatusBar();

      // ── Character tab ──
      $('charTab').innerHTML = `
        <div class="eyebrow">CHARACTER</div>
        <h2 style="font-size:1.2rem">${esc(c.name)}</h2>
        <div class="muted" style="font-size:.88rem">${esc(c.race)} ${esc(c.class)} · Lv ${c.level}</div>
        <div style="margin-top:12px">
          <div class="label">HP ${c.hp}/${c.max_hp}</div>
          <div class="bar"><div class="fill hp" style="width:${hpPct}%"></div></div>
        </div>
        <div style="margin-top:8px">
          <div class="label">MP ${c.mp}/${c.max_mp}</div>
          <div class="bar"><div class="fill mp" style="width:${mpPct}%"></div></div>
        </div>
        <div style="margin-top:8px">
          <div class="label">XP ${c.xp}/${state.xpNeeded}</div>
          <div class="bar"><div class="fill xp" style="width:${xpPct}%"></div></div>
        </div>
        <div class="meta-grid" style="margin-top:10px">
          <div class="statcard"><div class="label">ATK</div><div class="value">${s.attack}</div></div>
          <div class="statcard"><div class="label">DEF</div><div class="value">${s.defense}</div></div>
          <div class="statcard"><div class="label">DODGE</div><div class="value">${Math.min(18, Math.floor((s.dex || 0) * 0.6) + 2)}%</div></div>
          <div class="statcard"><div class="label">CRIT</div><div class="value">${Math.min(18, Math.floor((s.cha || 0) * 0.6) + 2)}%</div></div>
        </div>
        <div class="stats-compact">
          <div class="stat-cell"><span class="stat-abbr">STR</span><span class="stat-num">${s.str}</span></div>
          <div class="stat-cell"><span class="stat-abbr">DEX</span><span class="stat-num">${s.dex}</span></div>
          <div class="stat-cell"><span class="stat-abbr">INT</span><span class="stat-num">${s.int}</span></div>
          <div class="stat-cell"><span class="stat-abbr">WIS</span><span class="stat-num">${s.wis}</span></div>
          <div class="stat-cell"><span class="stat-abbr">CON</span><span class="stat-num">${s.con}</span></div>
          <div class="stat-cell"><span class="stat-abbr">CHA</span><span class="stat-num">${s.cha}</span></div>
        </div>
        ${(() => {
          const rp = gameData.racialPassives?.[c.race];
          return rp ? `<div style="margin-top:10px;padding:6px 8px;background:rgba(255,193,7,0.08);border:1px solid rgba(255,193,7,0.2);border-radius:6px;font-size:.78rem">
            <span style="color:var(--amber)">${rp.icon} <strong>${esc(rp.name)}</strong></span>
            <span class="muted"> \u2014 ${esc(rp.description)}</span>
          </div>` : '';
        })()}
        <div class="actions" style="margin-top:12px;display:flex;gap:6px">
          <button class="small" data-action="openInventoryModal">🎒 Inventory</button>
          <button class="small" data-action="enterProgression">🏆 Achievements</button>
          <button class="small" data-action="enterCodex">📖 Codex</button>
        </div>`;

      renderStoryPanel();
      renderNavPanel();
      renderLogTab();
      ensureLoadingCleared();
      audioUpdateTrack();

      // Trigger or continue guided tutorial
      if (shouldShowTutorial()) {
        if (!_tutActive) startTutorial();
        else setTimeout(() => checkTutorialProgress(), 50);
      }
    }

    // ── Inventory modal ──
    let invFilter = 'all';
    let invSelectedKey = null;
    let invSearch = '';
    let invSort = 'type'; // 'type' | 'rarity' | 'value' | 'name'
    let forgeSelectedSlot = null;
    let forgeTab = 'socket'; // 'socket' | 'enchant'
    let shopTab = 'buy';
    let shopSlotFilter = 'all';
    let selectedShopItem = null;
    // Arena state
    let arenaStoreData = null;
    let arenaStoreSelected = null;
    let arenaLeaderboard = null;
    let guildTab = 'bounties';
    let activeBounties = null;
    let maxActiveBounties = 5;
    let bountyBoard = null;
    let guildVendorStock = null;
    let guildRankInfo = null;

    const CLASS_PRIMARY_STAT = { warrior:'str', mage:'int', rogue:'dex', cleric:'wis', ranger:'dex' };
    const CLASS_SECONDARY_STAT = { warrior:'con', mage:'wis', rogue:'cha', cleric:'con', ranger:'wis' };

    function setShopTab(tab) { shopTab = tab; shopSlotFilter = 'all'; selectedShopItem = null; renderGame(); }
    function setShopSlotFilter(f) { shopSlotFilter = f; selectedShopItem = null; renderGame(); }
    function selectShopItem(id) { selectedShopItem = selectedShopItem === id ? null : id; renderGame(); }

    function openInventoryModal() {
      // Block inventory during raids except pre-boss recovery phase
      if (partyRaidState && partyRaidState.phase !== 'preBoss' && partyRaidState.phase !== 'complete') {
        showMessage('Inventory is locked during raids. You can access it before each boss fight.', true);
        return;
      }
      const existing = document.getElementById('invOverlay');
      if (existing) existing.remove();
      invSelectedKey = null;
      invSearch = '';
      renderInventoryModal();
    }
    function closeInventoryModal() {
      const el = document.getElementById('invOverlay');
      if (el) el.remove();
    }
    function setInvFilter(f) { invFilter = f; renderInventoryModal(); }

    function selectInvItem(key) { invSelectedKey = invSelectedKey === key ? null : key; renderInventoryModal(); }
    function setInvSearch(val) { invSearch = val; invSelectedKey = null; renderInventoryModal(); }

    function renderInventoryModal() {
      const c = state.character;
      const myPrimary = CLASS_PRIMARY_STAT[c.class] || 'str';

      // Equipment column — compact slots
      let eqHtml = `<div class="label" style="margin-bottom:8px">EQUIPPED GEAR</div>`;
      eqHtml += EQUIP_SLOTS.map(slot => {
        const item = state.equipment[slot];
        if (!item) return `<div class="eq-slot"><span class="eq-label">${slot}</span><span class="eq-empty">Empty</span></div>`;
        const durPct = Math.max(0, Math.min(100, (item.durability / item.maxDurability) * 100));
        const durLow = item.durability <= 5;
        const maxSockets = item.maxSockets || 0;
        const filledSockets = item.sockets ? item.sockets.filter(s => s).length : 0;
        const socketBadge = maxSockets > 0 ? ' <span style="font-size:.6rem;color:#a78bfa">💎' + filledSockets + '/' + maxSockets + '</span>' : '';
        return `<div class="eq-slot">
          <span class="eq-label">${slot}</span>
          <div class="eq-info">
            <div class="eq-name rarity-${item.rarity}">${esc(item.name)}${socketBadge}</div>
            ${renderStatSummary(item.stats || {}, { myPrimary })}
            ${renderPerks(item.perks)}
            ${item.sockets ? item.sockets.filter(s=>s).map(s => '<div style="font-size:.68rem;color:#a78bfa;margin-top:1px">💎 ' + esc(s.name) + '</div>').join('') : ''}
            <div style="display:flex;align-items:center;gap:6px;margin-top:3px">
              <div class="bar thin" style="flex:1;margin:0"><div class="fill ${durLow ? 'dur-low' : 'dur'}" style="width:${durPct}%"></div></div>
              <span style="font-size:.6rem;color:var(--muted)">${item.durability}/${item.maxDurability}</span>
            </div>
            <div style="margin-top:4px"><button class="secondary small" data-action="unequipFromModal" data-slot="${slot}" ${c.in_combat ? 'disabled' : ''}>Unequip</button></div>
          </div>
        </div>`;
      }).join('');

      // Pack — filter + search + sort + two-panel
      const filterTypes = ['all', 'equipment', 'consumable', 'material', 'gem', 'recipe', 'crystal'];
      let filtered = invFilter === 'all' ? state.inventory
        : invFilter === 'equipment' ? state.inventory.filter(i => EQUIP_SLOTS.includes(i.type))
        : state.inventory.filter(i => i.type === invFilter);
      if (invSearch) {
        const sq = invSearch.toLowerCase();
        filtered = filtered.filter(i => {
          if ((i.name || '').toLowerCase().includes(sq)) return true;
          if ((i.slug || '').toLowerCase().includes(sq)) return true;
          if ((i.type || '').toLowerCase().includes(sq)) return true;
          if ((i.rarity || '').toLowerCase().includes(sq)) return true;
          if (i.perks && i.perks.some(p => (p.type || '').toLowerCase().includes(sq) || (p.stat || '').toLowerCase().includes(sq))) return true;
          return false;
        });
      }
      // Sort
      const rarityOrder = { mythic: 6, legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };
      if (invSort === 'rarity') filtered.sort((a, b) => (rarityOrder[b.rarity] || 0) - (rarityOrder[a.rarity] || 0) || (a.name || '').localeCompare(b.name || ''));
      else if (invSort === 'value') filtered.sort((a, b) => ((b.sell || 0) * (b.quantity || 1)) - ((a.sell || 0) * (a.quantity || 1)));
      else if (invSort === 'name') filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      else filtered.sort((a, b) => { const ta = EQUIP_SLOTS.includes(a.type) ? 0 : a.type === 'consumable' ? 1 : a.type === 'material' ? 2 : 3; const tb = EQUIP_SLOTS.includes(b.type) ? 0 : b.type === 'consumable' ? 1 : b.type === 'material' ? 2 : 3; return ta - tb || (rarityOrder[b.rarity] || 0) - (rarityOrder[a.rarity] || 0); });

      const itemKey = (item) => item.inventoryId ? 'inv-' + item.inventoryId : item.slug;
      if (!invSelectedKey && filtered.length) invSelectedKey = itemKey(filtered[0]);
      const sel = filtered.find(i => itemKey(i) === invSelectedKey) || null;
      const equipped = sel ? getEquippedItemFor(sel) : null;

      const totalItems = state.inventory.reduce((s, i) => s + (i.quantity || 1), 0);
      let packHtml = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="label">PACK <span class="muted" style="font-weight:400">(${state.inventory.length} stacks · ${totalItems} items)</span></div>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="invAutoJunkSelect" style="font-size:.72rem;padding:3px 6px;border-radius:6px;background:rgba(255,90,90,.08);border:1px solid rgba(255,90,90,.25);color:rgba(255,130,130,.85)">
            <option value="">🗑 Auto-Junk…</option>
            <option value="common">≤ Common</option>
            <option value="uncommon">≤ Uncommon</option>
            <option value="rare">≤ Rare</option>
            <option value="epic">≤ Epic</option>
            <option value="legendary">≤ Legendary</option>
          </select>
          <select id="invSortSelect" style="font-size:.72rem;padding:3px 6px;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--text)">
            <option value="type" ${invSort==='type'?'selected':''}>Sort: Type</option>
            <option value="rarity" ${invSort==='rarity'?'selected':''}>Sort: Rarity</option>
            <option value="value" ${invSort==='value'?'selected':''}>Sort: Value</option>
            <option value="name" ${invSort==='name'?'selected':''}>Sort: Name</option>
          </select>
        </div>
      </div>`;
      packHtml += `<div class="inv-filter-bar" style="margin-bottom:6px">${filterTypes.map(f =>
        `<button class="${invFilter === f ? '' : 'secondary'} small" data-action="setInvFilter" data-filter="${f}">${f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}</button>`
      ).join('')}</div>`;
      packHtml += `<div style="margin-bottom:8px"><input type="text" placeholder="Search name, type, rarity, perk..." value="${esc(invSearch)}" id="invSearchInput" style="padding:8px 12px;font-size:.85rem;border-radius:10px" /></div>`;

      // Two-panel: list + detail
      packHtml += `<div class="ah-panels" style="min-height:340px">`;
      // Left: item list
      packHtml += `<div class="ah-item-list" style="max-height:480px">`;
      if (filtered.length) {
        packHtml += filtered.map(item => {
          const key = itemKey(item);
          const isSel = key === invSelectedKey;
          const hasPerks = item.perks && item.perks.length > 0;
          return `<div class="ah-list-item${isSel ? ' selected' : ''}${item.junk ? ' junk-item' : ''}${hasPerks ? ' inv-perked' : ''}" data-action="selectInvItem" data-id="${key}">
            <span class="ali-slot">${esc(item.type||'')}</span>
            <span class="ali-name rarity-${item.rarity}">${item.junk ? '<span style="opacity:.5">🗑 </span>' : ''}${hasPerks ? '✦ ' : ''}${esc(item.name)}${item.quantity>1?' <span class="muted">×'+item.quantity+'</span>':''}</span>
          </div>`;
        }).join('');
      } else {
        packHtml += `<div style="padding:16px;text-align:center;color:var(--muted);font-style:italic">${invFilter==='all'&&!invSearch ? 'Pack is empty.' : 'No matching items.'}</div>`;
      }
      packHtml += `</div>`;

      // Right: detail pane
      packHtml += `<div class="ah-detail" style="max-height:480px">`;
      if (sel) {
        const compareStats = equipped?.stats || null;
        packHtml += `
          <div class="eyebrow" style="margin-bottom:4px">${esc(sel.type||'').toUpperCase()}</div>
          <h3 style="margin:0 0 4px">${sel.junk ? '<span style="opacity:.45">🗑 </span>' : ''}<span class="rarity-${sel.rarity}">${esc(sel.name)}</span>${sel.quantity>1?' <span class="muted" style="font-size:.85rem">×'+sel.quantity+'</span>':''}</h3>
          <div class="mono muted" style="font-size:.8rem">${sel.rarity}${sel.sell ? ' · Sells for ' + sel.sell + 'g' : ''}${sel.classReq ? ' · <span style="color:' + (sel.classReq === c.class ? '#22c55e' : '#ef4444') + '">' + sel.classReq.charAt(0).toUpperCase() + sel.classReq.slice(1) + ' only</span>' : ''}</div>
          ${sel.description ? '<div class="muted" style="font-size:.88rem;margin-top:6px">' + esc(sel.description) + '</div>' : ''}
          ${renderStatSummary(sel.stats || {}, { compareStats, myPrimary })}
          ${renderItemEffectSummary(sel)}
          ${renderPerks(sel.perks)}
          ${sel.gem ? '<div style="margin-top:6px;font-size:.82rem;color:#a78bfa;font-weight:600">💎 ' + Object.entries(sel.gem.bonus || {}).map(function(e) { var labels = {attackPct:'ATK',defensePct:'DEF',hpRegenPct:'HP Regen',mpRegenPct:'MP Regen',critPct:'Crit',dodgePct:'Dodge'}; return '+' + e[1] + '% ' + (labels[e[0]] || e[0]); }).join(', ') + ' <span class="muted">(' + sel.gem.tier + ')</span></div>' : ''}
          ${equipped && compareStats ? '<div class="compare-hint muted" style="font-size:.72rem;margin-top:6px">vs equipped: <strong class="rarity-' + (equipped.rarity||'common') + '">' + esc(equipped.name||'—') + '</strong></div>' : ''}
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">
            ${!sel.junk && EQUIP_SLOTS.includes(getItemEquipSlot(sel)) ? '<button class="secondary small" data-action="equipFromModal" data-item-slug="' + sel.slug + '" data-inventory-id="' + (sel.inventoryId||'') + '"' + (c.in_combat ? ' disabled' : '') + '>Equip</button>' : ''}
            ${!sel.junk && sel.type === 'consumable' && !c.in_combat && !sel.use?.combatOnly && !(partyData?.state === 'in_raid') && !c.raid_state ? '<button class="green small" data-action="useFromModal" data-slug="' + sel.slug + '">Use</button>' : ''}
            ${!sel.junk && sel.type === 'recipe' && !c.in_combat ? '<button class="violet small" data-action="learnFromModal" data-slug="' + sel.slug + '">Study</button>' : ''}
            ${!sel.junk && state.home?.isAtHome && !c.in_combat && sel.type !== 'recipe' ? '<button class="small" data-action="storeFromModal" data-item-slug="' + sel.slug + '" data-qty="' + sel.quantity + '">Store</button>' : ''}
            ${!c.in_combat ? '<button class="junk-btn small' + (sel.junk ? ' active' : '') + '" data-action="toggleJunkFromModal" data-slug="' + sel.slug + '" data-inventory-id="' + (sel.inventoryId||'') + '">' + (sel.junk ? '↩ Unmark' : '🗑 Junk') + '</button>' : ''}
          </div>`;
      } else {
        packHtml += `<div class="ah-detail-empty">Select an item to view details</div>`;
      }
      packHtml += `</div></div>`;

      // Build or update overlay
      let overlay = document.getElementById('invOverlay');
      const savedEqScroll = overlay?.querySelector('.inv-equip-col')?.scrollTop || 0;
      const savedListScroll = overlay?.querySelector('.ah-item-list')?.scrollTop || 0;
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'inv-overlay';
        overlay.id = 'invOverlay';
        overlay.onclick = (e) => { if (e.target === overlay) closeInventoryModal(); };
        document.body.appendChild(overlay);
      }
      overlay.innerHTML = `
        <div class="inv-modal">
          <div class="inv-header">
            <h3>🎒 Inventory & Equipment</h3>
            <button class="secondary small" data-action="closeInventoryModal">✕ Close</button>
          </div>
          <div class="inv-body">
            <div class="inv-equip-col">${eqHtml}</div>
            <div class="inv-pack-col">${packHtml}</div>
          </div>
        </div>`;
      const newEqCol = overlay.querySelector('.inv-equip-col');
      if (newEqCol) newEqCol.scrollTop = savedEqScroll;
      const newListCol = overlay.querySelector('.ah-item-list');
      if (newListCol) newListCol.scrollTop = savedListScroll;
      // Wire search input
      const searchEl = overlay.querySelector('#invSearchInput');
      if (searchEl) {
        searchEl.addEventListener('input', (e) => { invSearch = e.target.value; invSelectedKey = null; renderInventoryModal(); searchEl.focus(); });
        if (invSearch) { searchEl.setSelectionRange(invSearch.length, invSearch.length); }
      }
      // Wire sort dropdown
      const sortEl = overlay.querySelector('#invSortSelect');
      if (sortEl) {
        sortEl.addEventListener('change', (e) => { invSort = e.target.value; renderInventoryModal(); });
      }
      // Wire auto-junk dropdown
      const autoJunkEl = overlay.querySelector('#invAutoJunkSelect');
      if (autoJunkEl) {
        autoJunkEl.addEventListener('change', (e) => { if (e.target.value) autoJunkByRarity(e.target.value); e.target.value = ''; });
      }
    }

    // Modal-aware action wrappers — perform action, refresh game, re-render modal
    async function equipFromModal(itemSlug, inventoryId) {
      _tutDidEquip = true;
      await act(post('/api/fantasy/equip', { itemSlug, inventoryId }), 'Item equipped.');
      renderInventoryModal();
    }
    async function unequipFromModal(slot) {
      await act(post('/api/fantasy/unequip', { slot }), 'Item unequipped.');
      renderInventoryModal();
    }
    async function useFromModal(itemSlug) {
      await act(post('/api/fantasy/use', { itemSlug }), 'Item used.');
      renderInventoryModal();
    }
    async function learnFromModal(itemSlug) {
      await act(post('/api/fantasy/learn-recipe', { itemSlug }));
      renderInventoryModal();
    }
    async function storeFromModal(itemSlug, maxQty) {
      const qty = await appQuantityPicker('Store how many?', maxQty, maxQty);
      if (qty == null) return;
      storyView = 'home';
      await act(post('/api/fantasy/home/store', { itemSlug, quantity: qty }));
      renderInventoryModal();
    }
    async function toggleJunkFromModal(itemSlug, inventoryId) {
      try {
        const body = { itemSlug };
        if (inventoryId) body.inventoryId = inventoryId;
        const res = await post('/api/fantasy/inventory/mark-junk', body);
        if (!res) return;
        applyState(res);
        renderGame();
        renderInventoryModal();
      } catch (err) { showMessage(err.message, true); }
    }

    async function autoJunkByRarity(maxRarity) {
      const rarityOrder = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6 };
      const threshold = rarityOrder[maxRarity] || 0;
      const EQUIP_TYPES = ['weapon', 'shield', 'body', 'helmet', 'gloves', 'boots', 'amulet', 'ring', 'trinket'];
      const targets = state.inventory.filter(i =>
        EQUIP_TYPES.includes(i.type) && !i.junk && (rarityOrder[i.rarity] || 0) <= threshold
      );
      if (!targets.length) { showMessage('No equipment to mark as junk at that rarity or below.'); return; }
      const ok = await appConfirm(
        `Mark <strong>${targets.length}</strong> equipment item${targets.length > 1 ? 's' : ''} (≤ ${maxRarity}) as junk?`,
        '🗑 Mark as Junk', 'Cancel'
      );
      if (!ok) return;
      let marked = 0;
      for (const item of targets) {
        try {
          const body = { itemSlug: item.slug };
          if (item.inventoryId) body.inventoryId = item.inventoryId;
          const res = await post('/api/fantasy/inventory/mark-junk', body);
          if (res) { applyState(res); marked++; }
        } catch (err) { /* skip failures */ }
      }
      renderGame();
      renderInventoryModal();
      ensureLoadingCleared();
      showMessage(`Marked ${marked} item${marked !== 1 ? 's' : ''} as junk.`);
    }

    // ── Log ──
    function classifyLogEntry(text) {
      const t = text.toLowerCase();
      if (t.includes('💀') || t.includes('defeated') || t.includes('slain') || t.includes('combat') || t.includes('attacked') || t.includes('damage') || t.includes('fled') || t.includes('killed')) return 'combat';
      if (t.includes('💰') || t.includes('loot') || t.includes('found') || t.includes('dropped') || t.includes('🎒') || t.includes('picked up') || t.includes('materials')) return 'loot';
      if (t.includes('🗺') || t.includes('traveled') || t.includes('arrived') || t.includes('journey') || t.includes('travel')) return 'travel';
      if (t.includes('📜') || t.includes('quest') || t.includes('🏆') || t.includes('accepted') || t.includes('completed') || t.includes('stage') || t.includes('recipe')) return 'quest';
      if (t.includes('⬆') || t.includes('level') || t.includes('leveled')) return 'level';
      if (t.includes('rest') || t.includes('inn') || t.includes('recovered')) return 'rest';
      if (t.includes('bought') || t.includes('sold') || t.includes('shop') || t.includes('purchase') || t.includes('merchant')) return 'shop';
      if (t.includes('craft') || t.includes('stored') || t.includes('retrieved') || t.includes('cottage') || t.includes('stash')) return 'shop';
      if (t.includes('dungeon') || t.includes('🏰') || t.includes('room') || t.includes('boss')) return 'dungeon';
      return '';
    }
    function clusterLogEntries(entries) {
      if (!entries.length) return [];
      const clusters = []; let current = null;
      for (const entry of entries) {
        const type = classifyLogEntry(entry.entry);
        const ts = new Date(entry.created_at).getTime();
        if (current && (ts - current.lastTs < 60000) && current.entries.length < 12) {
          current.entries.push(entry); current.lastTs = ts;
          if (type && !current.types.has(type)) current.types.add(type);
        } else {
          if (current) clusters.push(current);
          current = { entries: [entry], types: new Set(type ? [type] : []), firstTs: ts, lastTs: ts };
        }
      }
      if (current) clusters.push(current);
      return clusters;
    }
    function summarizeCluster(cluster) {
      const types = [...cluster.types];
      if (types.includes('combat') && types.includes('loot')) return '⚔ Combat & loot';
      if (types.includes('combat')) return '⚔ Combat encounter';
      if (types.includes('quest') && types.includes('travel')) return '📜 Quest & travel';
      if (types.includes('quest')) return '📜 Quest progress';
      if (types.includes('travel')) return '🗺 Journey';
      if (types.includes('loot')) return '🎒 Loot collected';
      if (types.includes('dungeon')) return '🏰 Dungeon run';
      if (types.includes('shop')) return '🛒 Market activity';
      return '📖 Events';
    }
    function renderLogTab() {
      const entries = (state.log || []).slice().reverse(); // oldest first (DB returns DESC)
      let feedHtml = '';
      for (const entry of entries) {
        const type = classifyLogEntry(entry.entry);
        const time = new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        feedHtml += `<div class="log-entry${type ? ' log-' + type : ''}"><span class="log-time">${time}</span><span class="log-text">${esc(entry.entry)}</span></div>`;
      }
      $('logTab').innerHTML = `<div class="eyebrow">ADVENTURE LOG</div>
        <div class="log-feed">${feedHtml || '<div style="padding:12px;color:var(--muted)">Your story has not yet begun.</div>'}</div>`;
      const feed = $('logTab').querySelector('.log-feed');
      if (feed) feed.scrollTop = feed.scrollHeight;
    }

    // ══════════════════════════════════════════
    //  ACTIONS
    // ══════════════════════════════════════════
    function selectRace(slug) { selectedRace = slug; renderCreateView(); }
    function selectClass(slug) { selectedClass = slug; renderCreateView(); }

    function showCombatResultOverlay(result) {
      // Remove existing overlay if any
      const existing = document.getElementById('combatResultOverlay');
      if (existing) existing.remove();

      const isVictory = result.victory && !result.fled;
      const isFled = result.fled;
      const isArenaDefeat = result.arenaDefeat;
      const modeClass = isArenaDefeat ? 'cr-fled' : isVictory ? 'cr-victory' : isFled ? 'cr-fled' : 'cr-defeat';
      const title = isArenaDefeat ? `🏟 ARENA — WAVE ${result.arenaWave}` : isVictory ? '⚔ VICTORY' : isFled ? '🏃 FLED' : '☠ DEFEAT';
      const subtitle = isArenaDefeat ? `You fell in wave ${result.arenaWave}. Earned ${result.arenaAp} Arena Points!` : isVictory ? 'You have defeated your enemy!' : isFled ? 'You escaped from combat.' : 'You have fallen in battle.';
      if (!isVictory && !isFled && !isArenaDefeat && !isTipSeen('death')) { markTipSeen('death'); }

      // Parse rewards from combat log
      const rewards = [];
      for (const line of result.log) {
        if (line.includes('XP') && line.includes('+')) rewards.push({ cls: 'cr-xp', text: line });
        else if (line.includes('gold') && (line.includes('+') || line.includes('bonus'))) rewards.push({ cls: 'cr-gold', text: line });
        else if (line.includes('📦') || line.includes('Loot')) rewards.push({ cls: 'cr-loot', text: line });
        else if (line.includes('🌿') || line.includes('Materials')) rewards.push({ cls: 'cr-loot', text: line });
        else if (line.includes('LEVEL UP') || line.includes('⬆')) rewards.push({ cls: 'cr-level', text: line });
        else if (line.includes('🏆') || line.includes('DUNGEON COMPLETE')) rewards.push({ cls: 'cr-quest', text: line });
        else if (line.includes('📜') && line.includes('Quest')) rewards.push({ cls: 'cr-quest', text: line });
        else if (line.includes('🤡')) rewards.push({ cls: 'cr-noob', text: line });
        else if (line.includes('💥') || line.includes('broke')) rewards.push({ cls: 'cr-dmg', text: line });
        else if (line.includes('🚨') && line.includes('durability')) rewards.push({ cls: 'cr-durwarn', text: line });
        else if (line.includes('🔧') && line.includes('Boss victory')) rewards.push({ cls: 'cr-repair', text: line });
        else if (line.includes('📦') || line.includes('Received')) rewards.push({ cls: 'cr-loot', text: line });
        else if (line.includes('🛠') || line.includes('recipe')) rewards.push({ cls: 'cr-loot', text: line });
      }

      const overlay = document.createElement('div');
      overlay.className = 'combat-result-overlay';
      overlay.id = 'combatResultOverlay';
      overlay.innerHTML = `
        <div class="combat-result-modal ${modeClass}">
          <div class="cr-title">${title}</div>
          <div class="cr-subtitle">${subtitle}</div>
          ${!isVictory && !isFled && !isArenaDefeat && !result.raidDefeat ? '<div style="font-size:.85rem;color:var(--muted);margin-bottom:10px;font-style:italic">You respawn at the nearest town. No XP or gold lost. Repair any broken gear at a shop.</div>' : ''}
          ${rewards.length ? `<div class="cr-rewards">${rewards.map(r => `<div class="cr-reward ${r.cls}">${esc(r.text)}</div>`).join('')}</div>` : ''}
          <div class="label" style="margin-bottom:4px">COMBAT LOG</div>
          <div class="cr-log">${result.log.map(l => `<div class="cr-log-entry">${esc(l)}</div>`).join('')}</div>
          <button class="primary-action" data-action="dismissCombatResult" style="align-self:center">${isVictory ? 'Continue' : isFled ? 'Continue' : 'Continue'}</button>
        </div>`;
      document.body.appendChild(overlay);
      // Scroll combat log to bottom
      const logEl = overlay.querySelector('.cr-log');
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
      pendingCombatResult = null;
    }
    function dismissCombatResult() {
      const overlay = document.getElementById('combatResultOverlay');
      if (overlay) overlay.remove();
      // Re-enter quest mode if a quest is active at this location (e.g. after quest combat)
      if (state?.activeQuests?.length) {
        const c = state.character;
        const qHere = state.activeQuests.find(q => {
          const def = gameData?.questDefs?.find(d => d.slug === q.quest_slug);
          return def?.location === c?.location && q.stage_data?.choices?.length;
        });
        if (qHere) {
          questMode = { slug: qHere.quest_slug, showChoices: false, outcome: null };
          renderGame();
        }
      }
    }

    function triggerCombatAnimations(res) {
      const log = res.combatLog || [];
      const panel = $('storyPanel');
      if (!panel) return;

      let hasPlayerHit = false;
      let hasCrit = false;
      let hasEnemyHit = false;
      let totalPlayerDmg = 0;
      let totalEnemyDmg = 0;
      let hasMiss = false;
      let hasHeal = false;

      for (const line of log) {
        const lower = line.toLowerCase();
        // Enemy took damage (player attack)
        if ((lower.includes('deals') || lower.includes('damage')) && !lower.includes('takes') && !lower.includes('you take')) {
          hasEnemyHit = true;
          const dmg = line.match(/(\d+)\s*damage/i);
          if (dmg) totalEnemyDmg += parseInt(dmg[1]);
        }
        // Player took damage
        if (lower.includes('takes') && lower.includes('damage') || lower.includes('you take')) {
          hasPlayerHit = true;
          const dmg = line.match(/(\d+)\s*damage/i);
          if (dmg) totalPlayerDmg += parseInt(dmg[1]);
        }
        if (lower.includes('critical') || lower.includes('crit')) hasCrit = true;
        if (lower.includes('miss') || lower.includes('dodged')) hasMiss = true;
        if (lower.includes('heal') || lower.includes('restore') || lower.includes('regen')) hasHeal = true;
      }

      // Shake enemy on hit
      if (hasEnemyHit) {
        const enemyEls = panel.querySelectorAll('[data-action="setCombatTarget"], .enemy-name');
        const target = enemyEls[0]?.closest('[style]') || enemyEls[0];
        if (target) {
          target.classList.add(hasCrit ? 'combat-shake' : 'combat-shake');
          setTimeout(() => target.classList.remove('combat-shake'), 350);
        }
      }

      // Flash player area on hit
      if (hasPlayerHit) {
        const charTab = $('charTab');
        if (charTab) {
          charTab.classList.add('combat-hit-flash');
          setTimeout(() => charTab.classList.remove('combat-hit-flash'), 450);
        }
      }

      // Floating damage numbers
      requestAnimationFrame(() => {
        if (totalEnemyDmg > 0) spawnDmgFloat(panel, totalEnemyDmg, hasCrit ? 'crit' : '', 'enemy');
        if (totalPlayerDmg > 0) spawnDmgFloat(panel, totalPlayerDmg, '', 'player');
        if (hasHeal) spawnDmgFloat(panel, '', 'heal', 'player');
        if (hasMiss) spawnDmgFloat(panel, 'MISS', 'miss', 'enemy');
      });

      // Victory/death effects
      if (res.combatOver && res.victory) {
        panel.classList.add('combat-victory-glow');
        setTimeout(() => panel.classList.remove('combat-victory-glow'), 1300);
      }
      if (res.combatOver && !res.victory && !res.fled) {
        panel.classList.add('combat-death-vignette');
        setTimeout(() => panel.classList.remove('combat-death-vignette'), 1600);
      }
    }

    function spawnDmgFloat(container, value, type, side) {
      const el = document.createElement('div');
      el.className = 'combat-dmg-float' + (type ? ' ' + type : '');
      el.textContent = type === 'heal' ? '+HP' : (typeof value === 'number' ? '-' + value : value);
      // Position: enemy side = top area, player side = bottom area
      const rect = container.getBoundingClientRect();
      el.style.position = 'absolute';
      if (side === 'enemy') {
        el.style.top = (40 + Math.random() * 30) + 'px';
        el.style.right = (20 + Math.random() * 40) + 'px';
      } else {
        el.style.bottom = (60 + Math.random() * 30) + 'px';
        el.style.left = (20 + Math.random() * 40) + 'px';
      }
      container.style.position = 'relative';
      container.appendChild(el);
      setTimeout(() => el.remove(), 1000);
    }

    // ══════════════════════════════════════════
    //  TOAST NOTIFICATION SYSTEM
    // ══════════════════════════════════════════
    const TOAST_MAX = 4;
    const TOAST_QUEUE = [];
    let toastContainer = null;

    function getToastContainer() {
      if (!toastContainer || !toastContainer.parentNode) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
      }
      return toastContainer;
    }

    /**
     * Show a toast notification.
     * @param {string} type - achievement|levelup|loot|mythic|quest|death|info|warning|error|arena|title-earned
     * @param {string} title - Short header text
     * @param {string} message - Body text
     * @param {object} opts - { duration, icon }
     */
    function showToast(type, title, message, opts = {}) {
      const icons = {
        achievement: '🏆', levelup: '⬆', loot: '📦', mythic: '🔴', quest: '📜',
        death: '💀', info: 'ℹ', warning: '⚠', error: '❌', arena: '🏟',
        'title-earned': '👑'
      };
      const durations = {
        achievement: 5000, levelup: 5000, mythic: 6000, death: 4000,
        'title-earned': 5000, arena: 4000, quest: 4000
      };
      const icon = opts.icon || icons[type] || 'ℹ';
      const duration = opts.duration || durations[type] || 3500;
      const container = getToastContainer();
      const active = container.querySelectorAll('.game-toast:not(.toast-hide)');

      // Queue if too many visible
      if (active.length >= TOAST_MAX) {
        TOAST_QUEUE.push({ type, title, message, opts });
        return;
      }

      const el = document.createElement('div');
      el.className = `game-toast toast-${type}`;
      el.innerHTML = `<span class="toast-icon">${icon}</span><div class="toast-body"><div class="toast-title">${esc(title)}</div><div class="toast-msg">${esc(message)}</div></div>`;
      el.addEventListener('click', () => dismissToast(el));
      container.appendChild(el);

      requestAnimationFrame(() => el.classList.add('toast-show'));
      const timer = setTimeout(() => dismissToast(el), duration);
      el._toastTimer = timer;
    }

    function dismissToast(el) {
      if (el._dismissed) return;
      el._dismissed = true;
      clearTimeout(el._toastTimer);
      el.classList.remove('toast-show');
      el.classList.add('toast-hide');
      setTimeout(() => {
        el.remove();
        // Process queue
        if (TOAST_QUEUE.length) {
          const next = TOAST_QUEUE.shift();
          showToast(next.type, next.title, next.message, next.opts);
        }
      }, 400);
    }

    // Legacy compatibility wrapper for durability toasts
    function showDurabilityToast(message, type) {
      const typeMap = { warn: 'warning', broke: 'error', noob: 'error' };
      const titleMap = { warn: 'Durability Warning', broke: 'Item Broke!', noob: 'Equipment Destroyed!' };
      showToast(typeMap[type] || 'warning', titleMap[type] || 'Warning', message, { duration: type === 'noob' ? 6000 : 4000 });
    }

    /**
     * Scan API response for notable events and fire toasts.
     * Called from act() after applyState.
     */
    function detectAndToast(res, prevLogId = null) {
      const messages = res.messages || [];
      const log = res.combatLog || [];
      const all = [...messages, ...log];

      // Level up detection
      for (const line of all) {
        if (line.includes('LEVEL UP') || line.includes('⬆')) {
          const match = line.match(/level\s*(\d+)/i);
          showToast('levelup', 'Level Up!', match ? `You reached level ${match[1]}!` : 'You grew stronger!');
          if (!isTipSeen('levelup')) { markTipSeen('levelup'); setTimeout(() => showToast('info', '⬆ Tip', 'Visit a Class Trainer at any hub town to learn new abilities!', { duration: 5000 }), 1500); }
          break;
        }
      }

      // Quest complete
      for (const line of messages) {
        if (line.includes('🏆') && (line.includes('Quest complete') || line.includes('quest complete'))) {
          const qname = line.replace(/.*🏆\s*/, '').replace(/[!.]+$/, '').trim();
          showToast('quest', 'Quest Complete', qname || 'A quest has been completed!');
          break;
        }
      }

      // Dungeon complete
      for (const line of messages) {
        if (line.includes('DUNGEON COMPLETE') || line.includes('dungeon cleared')) {
          showToast('quest', 'Dungeon Cleared', 'You conquered the dungeon!', { icon: '🏰' });
          break;
        }
      }

      // Death detection
      if (res.combatOver && !res.victory && !res.fled && !res.arenaDefeat && !res.raidDefeat) {
        showToast('death', 'You Died', `Respawned at ${esc(state.location?.name || 'town')}. 10% gold lost.`);
      }

      // Raid defeat
      if (res.raidDefeat) {
        showToast('death', 'Raid Failed', 'The corruption consumed your progress. Respawned at Sunspire.');
      }

      // Arena defeat
      if (res.arenaDefeat) {
        const wave = res.arenaWave || '?';
        const ap = res.arenaAp || 0;
        showToast('arena', 'Arena Run Over', `Reached wave ${wave}. Earned ${ap} AP.`);
      }

      // Exotic drop detection
      for (const line of all) {
        if (line.includes('EXOTIC DROP') || line.includes('🔷')) {
          const clean = line.replace(/🔷|EXOTIC DROP:/g, '').trim();
          showToast('mythic', '🔷 Exotic Drop!', clean || 'An exotic item was found!');
          break;
        }
      }

      // Mythic drop detection (in loot messages)
      for (const line of all) {
        if (line.toLowerCase().includes('mythic') && (line.includes('📦') || line.includes('Loot') || line.includes('found') || line.includes('MYTHIC DROP'))) {
          const clean = line.replace(/📦|🔴|Loot:|Found:|MYTHIC DROP:/g, '').trim();
          showToast('mythic', 'Mythic Drop!', clean || 'A mythic item was found!');
          break;
        }
      }

      // Achievement detection — check log entries newer than previous ID
      const currentLog = state?.log || [];
      if (currentLog.length > 0 && prevLogId !== null) {
        const newEntries = currentLog.filter(e => e.id > prevLogId);
        for (const entry of newEntries) {
          const text = entry.entry || entry;
          if (text.includes('🏆 Achievement Unlocked:')) {
            const match = text.match(/Achievement Unlocked:\s*(.+?)(?:\s*[+]|$)/);
            const achName = match ? match[1].trim() : 'New achievement unlocked!';
            showToast('achievement', 'Achievement Unlocked', achName);

            // Check for title reward
            if (text.includes('Title:')) {
              const titleMatch = text.match(/Title:\s*"([^"]+)"/);
              if (titleMatch) {
                setTimeout(() => showToast('title-earned', 'Title Earned', `"${titleMatch[1]}" is now available!`), 600);
              }
            }
          }
        }
      }
    }

    // ══════════════════════════════════════════
    //  GUIDED TUTORIAL & FIRST-USE TIPS
    // ══════════════════════════════════════════
    const GUIDED_TUTORIAL = [
      { id: 'welcome',       text: 'Welcome, adventurer! Let\'s get you started. First, <strong>visit the Market</strong> to buy some gear.', goal: 'Open the Market', check: () => storyView === 'market' },
      { id: 'filter-class',  text: 'Good! Now filter by <strong>"My Class"</strong> to see gear suited for you.', goal: 'Filter by My Class', check: () => storyView === 'market' && shopSlotFilter === 'myclass' },
      { id: 'buy-item',      text: 'Pick a piece of gear and <strong>buy it</strong>. A weapon or body armor is a good start.', goal: 'Buy an item', check: () => _tutLastInvCount !== null && state.inventory.length > _tutLastInvCount },
      { id: 'equip-item',    text: 'Now open your <strong>🎒 Inventory</strong> and <strong>equip</strong> your new gear.', goal: 'Equip an item', check: () => _tutDidEquip },
      { id: 'durability',    text: 'Notice the <strong>durability bar</strong> on your equipment. Gear wears down in combat — when it breaks, you lose its stats! Keep it repaired.', goal: 'Continue', check: () => _tutWaitContinue },
      { id: 'travel-woods',  text: 'Time for adventure! Click <strong>Whispering Woods</strong> on the minimap to the right, then confirm your travel.', goal: 'Travel to Whispering Woods', check: () => state.character?.location === 'whispering-woods' },
      { id: 'accept-quest',  text: 'You\'ve arrived! There\'s a <strong>quest available</strong> here. Accept it and see what awaits.', goal: 'Accept a quest', check: () => state.activeQuests?.length > 0 },
      { id: 'complete-quest', text: 'Work through the quest — read the story and make your choices. Complete it to earn rewards!', goal: 'Complete the quest', check: () => (state.completedQuests?.length || 0) > _tutStartCompletedCount },
      { id: 'return-town',   text: 'Quest done! Now <strong>travel back to Thornwall</strong> to rest and recover.', goal: 'Return to Thornwall', check: () => state.character?.location === 'thornwall' },
      { id: 'rest-inn',      text: 'Visit the <strong>Inn</strong> to restore your HP and MP to full.', goal: 'Rest at the Inn', check: () => _tutDidRest },
      { id: 'repair-gear',   text: 'Open the <strong>Market</strong> and go to the <strong>Repair</strong> tab to keep your gear in shape.', goal: 'Visit the Repair tab', check: () => storyView === 'market' && shopTab === 'repair' },
      { id: 'complete',      text: '<strong>You\'re ready!</strong> Complete quests in an area to unlock free exploration. Dungeons offer tougher enemies and better loot. Visit the <strong>Class Trainer</strong> to learn abilities. Good luck!', goal: 'Finish Tutorial', check: () => _tutWaitContinue },
    ];

    let _tutStep = 0;
    let _tutActive = false;
    let _tutLastInvCount = null;
    let _tutLastEquipCount = null;
    let _tutStartCompletedCount = 0;
    let _tutWaitContinue = false;
    let _tutDidRest = false;
    let _tutDidEquip = false;
    let _tutRewardClaimed = false;

    function getTutorialKey() {
      const charId = state?.character?.id;
      return charId ? `tutorial_guided_${charId}` : null;
    }
    function getTutorialStep() {
      const key = getTutorialKey();
      if (!key) return -1;
      const val = localStorage.getItem(key);
      return val === 'done' ? -1 : parseInt(val || '0', 10);
    }
    function saveTutorialStep(step) {
      const key = getTutorialKey();
      if (key) localStorage.setItem(key, step === -1 ? 'done' : String(step));
    }
    function isTutorialDone() { return getTutorialStep() === -1; }
    function markTutorialDone() { saveTutorialStep(-1); _tutActive = false; }

    function shouldShowTutorial() {
      if (isTutorialDone()) return false;
      const c = state?.character;
      if (!c || c.in_combat) return false;
      return c.level <= 3;
    }
    // Call once on character load to reset tutorial for reset/new characters
    function checkTutorialReset() {
      const c = state?.character;
      if (!c) return;
      // Fresh character: level 1, minimal log, no completed quests = reset tutorial
      if (c.level === 1 && (state.completedQuests?.length || 0) === 0 && !isTutorialDone() && getTutorialStep() > 2) {
        saveTutorialStep(0);
        _tutActive = false;
      }
    }

    function startTutorial() {
      _tutStep = getTutorialStep();
      if (_tutStep < 0 || _tutStep >= GUIDED_TUTORIAL.length) return;
      _tutActive = true;
      _tutWaitContinue = false;
      _tutDidRest = false;
      _tutLastInvCount = state.inventory?.length || 0;
      _tutLastEquipCount = Object.values(state.equipment || {}).filter(Boolean).length;
      _tutStartCompletedCount = state.completedQuests?.length || 0;
      renderGame();
    }

    function skipTutorial() {
      markTutorialDone();
      renderGame();
    }

    function tutorialContinue() {
      _tutWaitContinue = true;
      checkTutorialProgress();
    }

    let _tutChecking = false;
    function checkTutorialProgress() {
      if (_tutChecking) return;
      if (!_tutActive || _tutStep < 0 || _tutStep >= GUIDED_TUTORIAL.length) return;
      const step = GUIDED_TUTORIAL[_tutStep];
      if (step.check()) {
        _tutChecking = true;
        _tutStep++;
        _tutWaitContinue = false;
        if (_tutStep >= GUIDED_TUTORIAL.length) {
          markTutorialDone();
          if (!_tutRewardClaimed) {
            _tutRewardClaimed = true;
            claimTutorialReward();
          }
        } else {
          saveTutorialStep(_tutStep);
          _tutLastInvCount = state.inventory?.length || 0;
          _tutLastEquipCount = Object.values(state.equipment || {}).filter(Boolean).length;
        }
        _tutChecking = false;
        renderGame();
      }
    }

    async function claimTutorialReward() {
      try {
        await act(post('/api/fantasy/tutorial/complete'));
        showToast('achievement', 'Tutorial Complete!', '+200 gold, +1 Arcane Token. Your adventure begins!', { icon: '🎓', duration: 6000 });
      } catch(e) { /* non-critical */ }
    }

    function renderTutorialBanner() {
      if (!_tutActive || _tutStep < 0 || _tutStep >= GUIDED_TUTORIAL.length) return '';
      const step = GUIDED_TUTORIAL[_tutStep];
      const progress = Math.round((_tutStep / GUIDED_TUTORIAL.length) * 100);
      const needsContinue = step.id === 'durability' || step.id === 'complete';
      return `<div class="tutorial-banner">
        <div class="tutorial-banner-header">
          <span class="tutorial-banner-label">🎓 TUTORIAL</span>
          <span class="tutorial-banner-progress">${_tutStep + 1}/${GUIDED_TUTORIAL.length}</span>
        </div>
        <div class="tutorial-banner-bar"><div class="tutorial-banner-fill" style="width:${progress}%"></div></div>
        <div class="tutorial-banner-text">${step.text}</div>
        <div class="tutorial-banner-goal">▶ ${esc(step.goal)}</div>
        <div class="tutorial-banner-actions">
          ${needsContinue ? '<button class="small" data-action="tutorialContinue">Got it →</button>' : ''}
          <button class="secondary small" data-action="skipTutorial">Skip Tutorial</button>
        </div>
      </div>`;
    }

    // ── Combat tutorial (spotlight overlay) ──
    const COMBAT_TUTORIAL_STEPS = [
      { target: '#combatAttackBtn', text: '<strong>⚔ Attack</strong> is your basic action. It costs nothing and always works. Use it when you\'re out of MP or saving resources.', pos: 'below' },
      { target: '#combatDefendBtn', text: '<strong>🛡 Defend</strong> halves incoming damage this turn and builds <strong>Momentum</strong>. A smart move when enemies telegraph big attacks!', pos: 'below' },
      { target: '#combatMomentum', text: '<strong>⚡ Momentum</strong> builds as you fight (especially when defending). Higher momentum boosts your damage. At max stacks you\'re unstoppable!', pos: 'below' },
      { target: '#combatAbilities', text: '<strong>Abilities</strong> are your strongest moves. They cost <strong>MP</strong> and some have <strong>cooldowns</strong> (shown as turns remaining). Hover or tap for details.', pos: 'below' },
      { target: '#combatActions', text: 'Watch the <strong>combat log</strong> below to see what happens each turn. If things go badly, you can always <strong>Flee</strong> to escape. Good luck!', pos: 'below' },
    ];
    let _combatTutStep = 0;
    let _combatTutActive = false;

    function getCombatTutKey() {
      const charId = state?.character?.id;
      return charId ? `combat_tut_${charId}` : null;
    }
    function isCombatTutDone() {
      const key = getCombatTutKey();
      return key ? localStorage.getItem(key) === '1' : true;
    }
    function markCombatTutDone() {
      const key = getCombatTutKey();
      if (key) localStorage.setItem(key, '1');
      _combatTutActive = false;
    }

    function startCombatTutorial() {
      if (isCombatTutDone()) return;
      _combatTutStep = 0;
      _combatTutActive = true;
      setTimeout(() => showCombatTutStep(), 400);
    }

    function showCombatTutStep() {
      const prev = document.getElementById('combatTutOverlay');
      if (prev) prev.remove();

      if (_combatTutStep >= COMBAT_TUTORIAL_STEPS.length) {
        markCombatTutDone();
        return;
      }

      const step = COMBAT_TUTORIAL_STEPS[_combatTutStep];
      const targetEl = document.querySelector(step.target);
      if (!targetEl) { _combatTutStep++; showCombatTutStep(); return; }

      // Scroll target into view first
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Wait for scroll to settle before positioning
      setTimeout(() => {
      const rect = targetEl.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) { _combatTutStep++; showCombatTutStep(); return; }
      const pad = 6;

      const overlay = document.createElement('div');
      overlay.id = 'combatTutOverlay';
      overlay.className = 'tutorial-overlay';
      overlay.style.pointerEvents = 'auto';

      const spot = document.createElement('div');
      spot.className = 'tutorial-spotlight';
      spot.style.cssText = `left:${rect.left - pad}px;top:${rect.top - pad}px;width:${rect.width + pad*2}px;height:${rect.height + pad*2}px;`;

      const tip = document.createElement('div');
      tip.className = 'tutorial-tooltip';
      tip.innerHTML = `
        <div class="tutorial-step">Combat ${_combatTutStep + 1} of ${COMBAT_TUTORIAL_STEPS.length}</div>
        <div class="tutorial-text">${step.text}</div>
        <div class="tutorial-buttons">
          <button class="tutorial-skip" id="combatTutSkip">Skip</button>
          <button class="tutorial-next" id="combatTutNext">${_combatTutStep < COMBAT_TUTORIAL_STEPS.length - 1 ? 'Next →' : 'Fight! ⚔'}</button>
        </div>`;

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); markCombatTutDone(); }
      });

      overlay.appendChild(spot);
      overlay.appendChild(tip);
      document.body.appendChild(overlay);

      // Wire up buttons after appending to DOM
      document.getElementById('combatTutNext').addEventListener('click', () => {
        _combatTutStep++;
        showCombatTutStep();
      });
      document.getElementById('combatTutSkip').addEventListener('click', () => {
        overlay.remove();
        markCombatTutDone();
      });

      // Position tooltip below target
      requestAnimationFrame(() => {
        const tipRect = tip.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow > tipRect.height + 20) {
          tip.style.top = (rect.bottom + 12) + 'px';
        } else {
          tip.style.top = Math.max(12, rect.top - tipRect.height - 12) + 'px';
        }
        tip.style.left = Math.max(12, Math.min(window.innerWidth - tipRect.width - 12, rect.left + rect.width/2 - tipRect.width/2)) + 'px';
      });
      }, 350); // end scroll timeout
    }

    // ── First-use system tips (localStorage) ──
    const SYSTEM_TIPS = {
      combat: { icon: '⚔', text: 'Use <strong>abilities</strong> for damage. <strong>Defend 🛡</strong> halves incoming hits. <strong>Flee</strong> if in danger. Watch for enemy <strong>telegraphs</strong>!' },
      shop: { icon: '🏪', text: 'Buy gear, sell loot, and <strong>repair</strong> damaged equipment. Mark items as <strong>junk</strong> for quick selling.' },
      dungeon: { icon: '🏰', text: 'Dungeons have multiple rooms and a <strong>boss</strong>. HP/MP carry between fights. Each dungeon has a <strong>unique hazard</strong>.' },
      bounty: { icon: '📋', text: 'Accept bounties to earn <strong>Guild Marks</strong>. Kill the required enemies, then <strong>claim</strong> your reward.' },
      forge: { icon: '🔨', text: 'Socket <strong>gems</strong> for % bonuses. <strong>Enchant</strong> gear for new perks. <strong>Extract</strong> perks into tradeable crystals.' },
      arena: { icon: '🏟', text: 'Wave survival — no fleeing, no potions. Earn <strong>Arena Points</strong> to spend in the Arena Store. Boss waves drop <strong>gems</strong>!' },
      academy: { icon: '📚', text: 'Learn new abilities with <strong>Arcane Tokens</strong>. Set separate <strong>PvE</strong> and <strong>PvP</strong> ability loadouts.' },
      event: { icon: '✨', text: 'Non-combat encounters! Choose wisely — <strong>stat checks</strong> determine success. Rewards vary by choice.' },
      levelup: { icon: '⬆', text: 'You leveled up! Stats increase automatically. Visit a <strong>Class Trainer</strong> at any hub town to learn new abilities.' },
      death: { icon: '☠', text: 'You\'ve fallen! You respawn at the nearest town. <strong>No XP or gold is lost.</strong> Repair any broken gear at a shop.' },
      realm: { icon: '🌀', text: 'New realm unlocked! Explore stronger zones with better loot. You can always travel back to previous realms.' },
      party: { icon: '👥', text: 'Party up for raids! All members must be at a <strong>raid town</strong> and ready before the leader can start.' },
      classTrainer: { icon: '⚔', text: 'Learn abilities, set your loadout, and complete <strong>class quests</strong> to unlock higher ability ranks.' },
    };

    function getTipKey(system) {
      const charId = state?.character?.id;
      return charId ? `tip_${system}_${charId}` : null;
    }

    function isTipSeen(system) {
      const key = getTipKey(system);
      return key ? localStorage.getItem(key) === '1' : true;
    }

    function markTipSeen(system) {
      const key = getTipKey(system);
      if (key) localStorage.setItem(key, '1');
    }

    function renderSystemTip(system) {
      if (isTipSeen(system)) return '';
      const tip = SYSTEM_TIPS[system];
      if (!tip) return '';
      return `<div class="system-tip" id="tip-${system}">
        <span class="system-tip-icon">${tip.icon}</span>
        <div class="system-tip-text">${tip.text}</div>
        <button class="system-tip-dismiss" data-action="dismissTip" data-slug="${system}" title="Dismiss">✕</button>
      </div>`;
    }

    function dismissTip(system) {
      markTipSeen(system);
      const el = document.getElementById('tip-' + system);
      if (el) el.remove();
    }

    function enterMarket() { storyView = 'market'; shopTab = 'buy'; shopSlotFilter = 'all'; selectedShopItem = null; renderStoryPanel(); if (_tutActive) setTimeout(() => checkTutorialProgress(), 50); }

    function enterGuild() { storyView = 'guild'; guildTab = 'bounties'; bountyBoard = null; activeBounties = null; guildVendorStock = null; renderStoryPanel(); }
    function leaveGuild() { storyView = 'menu'; lastMessages = []; renderStoryPanel(); }
    function setGuildTab(tab) { guildTab = tab; renderGame(); }

    async function loadBountyBoard() {
      try {
        const res = await post('/api/fantasy/bounty/board');
        bountyBoard = res.board || [];
        activeBounties = res.activeBounties || [];
        maxActiveBounties = res.maxActive || 5;
        guildRankInfo = res.guildRank;
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function loadGuildVendor() {
      try {
        const res = await post('/api/fantasy/guild/vendor');
        guildVendorStock = res.stock || [];
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function acceptBounty(bountyId) {
      try {
        const res = await post('/api/fantasy/bounty/accept', { bountyId });
        bountyBoard = res.board || bountyBoard;
        activeBounties = res.activeBounties || activeBounties;
        maxActiveBounties = res.maxActive || maxActiveBounties;
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function claimBounty(bountyId) {
      try {
        const res = await post('/api/fantasy/bounty/claim', { bountyId });
        applyState(res);
        bountyBoard = null; // reload
        activeBounties = null; // reload
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function abandonBounty(bountyId) {
      if (!await appConfirm('Abandon this bounty? All progress will be lost.', 'Abandon', 'Keep')) return;
      try {
        const res = await post('/api/fantasy/bounty/abandon', { bountyId });
        activeBounties = res.activeBounties || [];
        maxActiveBounties = res.maxActive || maxActiveBounties;
        bountyBoard = null; // reload to refresh accept buttons
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function guildRegister() {
      try {
        const res = await post('/api/fantasy/guild/register');
        applyState(res);
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function guildBuy(slug) {
      try {
        const res = await post('/api/fantasy/guild/buy', { itemSlug: slug });
        applyState(res);
        guildVendorStock = null; // reload
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    function enterAcademy() { enterClassTrainer(); } // Redirect to class trainer
    function leaveAcademy() { leaveClassTrainer(); }
    function setAcademyTab(tab) { academyTab = tab; selectedTalent = null; renderGame(); }
    function setAcademyFilter(filter) { academyFilter = filter; selectedTalent = null; renderGame(); }
    function selectTalent(slug) { selectedTalent = selectedTalent === slug ? null : slug; renderGame(); }

    function _getCurrentLoadout() {
      const a = state.abilities;
      if (!a) return [];
      return academyLoadoutMode === 'pvp' ? (a.activePvp || a.active) : academyLoadoutMode === 'raid' ? (a.activeRaid || a.active) : a.active;
    }
    function addToLoadout(slug) {
      if (!pendingLoadout) pendingLoadout = [..._getCurrentLoadout()];
      if (pendingLoadout.length >= 6) return;
      if (!pendingLoadout.includes(slug)) { pendingLoadout.push(slug); renderGame(); }
    }
    function removeFromLoadout(slug) {
      if (!pendingLoadout) pendingLoadout = [..._getCurrentLoadout()];
      pendingLoadout = pendingLoadout.filter(s => s !== slug);
      renderGame();
    }
    function resetLoadout() { pendingLoadout = null; renderGame(); }
    function setAcademyLoadoutMode(mode) {
      academyLoadoutMode = mode === 'pvp' ? 'pvp' : mode === 'raid' ? 'raid' : 'pve';
      pendingLoadout = null;
      selectedTalent = null;
      renderGame();
    }
    async function saveLoadout() {
      if (!pendingLoadout || !pendingLoadout.length) return;
      try {
        const res = await post('/api/fantasy/academy/equip', { activeAbilities: pendingLoadout, mode: academyLoadoutMode });
        applyState(res);
        pendingLoadout = null;
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function learnAbility(slug) {
      try {
        const res = await post('/api/fantasy/academy/learn', { abilitySlug: slug });
        applyState(res);
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function upgradeAbility(slug) {
      try {
        const res = await post('/api/fantasy/academy/upgrade', { abilitySlug: slug });
        applyState(res);
        showToast('info', 'Ability Upgraded', `${slug} ranked up!`, { icon: '⬆', duration: 3000 });
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    function enterAuction() { storyView = 'auction'; ahTab = 'browse'; ahSlotFilter = 'all'; ahRarityFilter = 'all'; ahSort = 'price-asc'; ahPage = 1; ahListings = null; ahMyListings = null; ahSellItem = null; renderStoryPanel(); }
    function leaveAuction() { storyView = 'menu'; lastMessages = []; renderStoryPanel(); }

    // ── Arena ──
    async function enterArena() {
      try { const res = await post('/api/fantasy/arena/enter'); applyState(res); renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function arenaNextWave() {
      try { const res = await post('/api/fantasy/arena/next-wave'); applyState(res); renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function arenaChoice(choice) {
      try { const res = await post('/api/fantasy/arena/choice', { choice }); applyState(res); renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function leaveArena() {
      try { const res = await post('/api/fantasy/arena/leave'); applyState(res); storyView = 'menu'; lastMessages = [`🏟 Arena run complete! Wave ${res.waveReached} reached. Earned ${res.apEarned} AP.`]; renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    function enterArenaStore() { storyView = 'arenaStore'; arenaStoreData = null; arenaStoreSelected = null; renderStoryPanel(); }

    // ── Raid Tower ──
    let raidListData = null;
    function enterRaidTower() { storyView = 'raidTower'; raidListData = null; loadRaidList(); startPartyPolling(); renderStoryPanel(); }
    function leaveRaidTower() { storyView = 'menu'; raidListData = null; if (!state.partyId) stopPartyPolling(); renderStoryPanel(); }
    async function loadRaidList() {
      try { const res = await post('/api/fantasy/raid/list'); raidListData = res; renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function enterRaid(slug) {
      const ok = await appConfirm('Once you enter a raid, you cannot leave between floors. If you die, all progress is lost. Are you ready?', 'Enter Raid', 'Cancel');
      if (!ok) return;
      try { const res = await post('/api/fantasy/raid/enter', { raidSlug: slug }); applyState(res); storyView = 'menu'; renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function raidAdvance() {
      try { const res = await post('/api/fantasy/raid/advance'); applyState(res); renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function raidChoice(idx) {
      try {
        const res = await post('/api/fantasy/raid/choice', { choiceIdx: Number(idx) });
        applyState(res);
        if (res.outcome) {
          const o = res.outcome;
          const rollText = o.rollInfo ? ` (${o.rollInfo.stat.toUpperCase()} check: rolled ${o.rollInfo.roll}+${o.rollInfo.modifier} = ${o.rollInfo.total} vs DC ${o.rollInfo.dc} — ${o.rollInfo.success ? 'SUCCESS' : 'FAILED'})` : '';
          lastMessages = [`${o.success ? '✅' : '❌'} ${o.text}${rollText}`, ...(o.messages || []).map(m => `  → ${m}`)];
        }
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function raidFloorChoice(choice) {
      try { const res = await post('/api/fantasy/raid/floor-choice', { choice }); applyState(res); renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function leaveRaid() {
      const ok = await appConfirm('Abandoning the raid will forfeit ALL progress and loot. Are you sure?', 'Abandon Raid', 'Stay');
      if (!ok) return;
      try { const res = await post('/api/fantasy/raid/leave'); applyState(res); storyView = 'menu'; lastMessages = ['🚪 You abandoned the raid.']; renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function dismissRaid() {
      try { const res = await post('/api/fantasy/raid/dismiss'); applyState(res); storyView = 'menu'; renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }

    // ── Party System ──
    let partyData = null;
    let partyInvites = [];
    let partyPollTimer = null;
    let partyCombatData = null;
    let partyRaidState = null;
    let partyCombatPollTimer = null;
    let partyTargetEnemy = null;  // selected enemy id for attacks
    let partyTargetAlly = null;   // selected player id for heals/buffs
    let _pollFailures = 0;
    const POLL_FAIL_THRESHOLD = 3;
    let partyEventSource = null;  // SSE connection

    function trackPollSuccess() {
      if (_pollFailures >= POLL_FAIL_THRESHOLD) hideConnectionBanner();
      _pollFailures = 0;
    }
    function trackPollFailure() {
      _pollFailures++;
      if (_pollFailures >= POLL_FAIL_THRESHOLD) {
        showConnectionBanner('Connection lost — attempting to reconnect...');
      }
    }

    // ── SSE-based updates (all authenticated players) ──
    function startSSE() {
      if (partyEventSource) return; // already connected
      if (typeof EventSource === 'undefined') return;
      partyEventSource = new EventSource('/api/fantasy/party/stream');
      partyEventSource.onopen = () => { console.log('[SSE] Connected'); trackPollSuccess(); };
      partyEventSource.onmessage = (e) => {
        try {
          trackPollSuccess();
          const data = JSON.parse(e.data);
          console.log('[SSE] Event:', data.type, data);
          if (data.type === 'state') handlePartySSE(data);
          else if (data.type === 'invites') handleInviteSSE(data);
          else if (data.type === 'invite') handleSingleInvite(data);
          else if (data.type === 'friendUpdate') handleFriendUpdate(data);
        } catch (err) { console.error('SSE parse error:', err); }
      };
      partyEventSource.onerror = () => {
        trackPollFailure();
        // EventSource auto-reconnects (3s retry set by server)
      };
    }
    function stopSSE() {
      if (partyEventSource) { partyEventSource.close(); partyEventSource = null; }
    }
    function handlePartySSE(data) {
      const hadParty = !!partyData;
      const wasInRaid = partyData?.state === 'in_raid';
      const prevPhase = partyRaidState?.phase;
      const prevLeaderName = (partyData?.members || []).find(m => m.isLeader)?.name;
      partyData = data.party;
      if (data.raidState !== undefined) { partyRaidState = data.raidState; if (data.raidState && data.raidState.phase !== 'choice') _raidVoteCast = false; }
      if (data.combat !== undefined) partyCombatData = data.combat;

      // Party disbanded
      if (hadParty && !partyData) {
        partyRaidState = null; partyCombatData = null;
        stopPartyCombatPolling();
        const wasRaidComplete = prevPhase === 'complete';
        const leaderName = prevLeaderName || 'The leader';
        showToast('info', 'Party', wasRaidComplete ? 'Raid complete — your adventure continues.' : 'The party was disbanded.');
        if (storyView === 'raidTower') storyView = 'menu';
        // Refetch character state — raid_state, HP/MP, gold/XP rewards all changed on the server.
        fetch('/api/fantasy/state', { credentials: 'include' }).then(r => r.json()).then(st => {
          if (st) state = { ...state, ...st };
          if (friendsOpen) renderFriendsOverlay();
          renderGame();
        }).catch(() => {
          if (friendsOpen) renderFriendsOverlay();
          renderGame();
        });
        return;
      }
      // Detect raid start
      if (partyData?.state === 'in_raid' && !wasInRaid) {
        storyView = 'raidTower';
        fetch('/api/fantasy/state', { credentials: 'include' }).then(r => r.json()).then(st => {
          if (st) state = { ...state, ...st };
          renderGame();
        }).catch(() => renderGame());
        return;
      }
      if (friendsOpen) renderFriendsOverlay();
      // Always re-render story panel so raid tower party UI updates
      if (storyView === 'raidTower') renderStoryPanel();
      // Victory/wipe
      if (partyCombatData?.phase === 'wipe') {
        partyData = null; partyCombatData = null; partyRaidState = null;
        showToast('death', 'Party Wipe', 'The raid is lost. All party members respawn.');
        fetch('/api/fantasy/state', { credentials: 'include' }).then(r => r.json()).then(st => {
          if (st) state = { ...state, ...st };
          storyView = 'menu';
          renderGame();
        }).catch(() => renderGame());
        return;
      }
      renderGame();
    }
    function handleInviteSSE(data) {
      const prevCount = partyInvites.length;
      partyInvites = data.pendingInvites || [];
      // Toast if a brand-new invite slipped in during a disconnect window
      if (partyInvites.length > prevCount) {
        const latest = partyInvites[0];
        showToast('info', 'Party Invite', `${latest?.from_name || 'Someone'} invited you to a raid party!`);
      }
      if (friendsOpen) renderFriendsOverlay();
      renderGame();
    }
    function handleFriendUpdate(data) {
      showToast('info', 'Friends', data.message || 'Friend list updated.');
      // Reload friends data if overlay is open
      if (friendsOpen) loadFriends();
    }
    function handleSingleInvite(data) {
      // Toast immediately — don't let a flaky poll swallow the notification
      showToast('info', 'Party Invite', `${data.invite?.from_name || 'Someone'} invited you to a raid party!`);
      // Then reload full invites from server for accuracy (real invite_id, etc.)
      fetch('/api/fantasy/party/poll', { credentials: 'include' }).then(r => r.json()).then(d => {
        partyInvites = d.pendingInvites || [];
        if (d.party) { partyData = d.party; }
        if (friendsOpen) renderFriendsOverlay();
        renderGame();
      }).catch(() => {});
    }

    function startPartyPolling() {
      startSSE();
      stopPartyPolling();
      // SSE is the fast path. Also keep a slow safety-net poll running so that
      // any missed SSE event (proxy hiccup, brief disconnect before reconnect
      // initial-state fires, etc.) doesn't leave party/raid UI stale.
      // Interval scales with whether SSE is live: 20s when SSE is connected,
      // 5s when falling back to polling alone.
      const interval = partyEventSource ? 20_000 : 5_000;
      pollParty();
      partyPollTimer = setInterval(pollParty, interval);
    }
    function stopPartyPolling() {
      // Don't stop SSE -- it stays connected for invite notifications
      if (partyPollTimer) { clearInterval(partyPollTimer); partyPollTimer = null; }
    }
    async function pollParty() {
      try {
        const resp = await fetch('/api/fantasy/party/poll', { credentials: 'include' });
        if (!resp.ok) { trackPollFailure(); return; }
        const data = await resp.json();
        trackPollSuccess();
        const hadParty = !!partyData;
        const wasInRaid = partyData?.state === 'in_raid';
        partyData = data.party;
        partyInvites = data.pendingInvites || [];
        // If party was disbanded under us
        if (hadParty && !partyData) {
          showToast('info', 'Party', 'The party was disbanded.');
          partyRaidState = null; partyCombatData = null;
          stopPartyCombatPolling();
          if (storyView === 'raidTower') renderStoryPanel();
          return;
        }
        // Pick up raid/combat state from party poll
        if (data.raidState) { partyRaidState = data.raidState; if (data.raidState.phase !== 'choice') _raidVoteCast = false; }
        if (data.combat) partyCombatData = data.combat;

        // Detect raid start — transition ALL members (not just leader) to raid polling
        if (partyData?.state === 'in_raid' && !wasInRaid) {
          startPartyCombatPolling();
          storyView = 'menu'; // leave raid tower view
          // Refresh full state since raid_state changed on character
          try {
            const st = await fetch('/api/fantasy/state', { credentials: 'include' }).then(r => r.json());
            if (st) state = { ...state, ...st };
          } catch(e) {}
        }
        // If already in raid, make sure combat polling is running
        if (partyData?.state === 'in_raid' && !partyCombatPollTimer) {
          startPartyCombatPolling();
        }
        // Re-render UI everywhere partyData is shown
        if (storyView === 'raidTower') renderStoryPanel();
        if (friendsOpen) renderFriendsOverlay();
        renderGame();
      } catch (e) { trackPollFailure(); }
    }

    async function partyCreate() {
      try {
        const res = await post('/api/fantasy/party/create');
        partyData = res.party;
        partyInvites = res.pendingInvites || [];
        friendsTab = 'party';
        // Reconnect SSE with new party_id
        stopSSE(); startSSE();
        // Refresh character state (party_id changed)
        const st = await fetch('/api/fantasy/state', { credentials: 'include' }).then(r => r.json());
        if (st) state = { ...state, ...st };
        if (friendsOpen) renderFriendsOverlay();
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    let _partyInviteList = null; // null = hidden, [] = loaded but empty, [...] = friends to show
    async function openPartyInvite() {
      if (_partyInviteList) { _partyInviteList = null; if (friendsOpen) renderFriendsOverlay(); renderStoryPanel(); return; } // toggle off
      try {
        const resp = await fetch('/api/fantasy/friends', { credentials: 'include' });
        if (!resp.ok) return;
        const data = await resp.json();
        const alreadyInParty = new Set((partyData?.members || []).map(m => m.charId));
        const alreadyInvited = new Set((partyData?.invites || []).map(i => i.toCharId));
        const onlineFriends = (data.friends || []).filter(f => f.online && !alreadyInParty.has(f.charId) && !alreadyInvited.has(f.charId));
        _partyInviteList = onlineFriends;
        if (friendsOpen) renderFriendsOverlay();
        renderStoryPanel();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyAccept(id) {
      try {
        const res = await post('/api/fantasy/party/accept', { inviteId: Number(id) });
        partyData = res.party;
        partyInvites = res.pendingInvites || [];
        partyRaidState = res.raidState || null;
        partyCombatData = res.combat || null;
        friendsTab = 'party';
        showToast('info', 'Party', 'Joined the party! Head to a Raid Tower to ready up.');
        // Refresh character state (party_id changed)
        const st = await fetch('/api/fantasy/state', { credentials: 'include' }).then(r => r.json());
        if (st) { state = { ...state, ...st }; }
        // Reconnect SSE with new party_id
        stopSSE(); startSSE();
        if (friendsOpen) renderFriendsOverlay();
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyDecline(id) {
      try {
        await post('/api/fantasy/party/decline', { inviteId: Number(id) });
        partyInvites = partyInvites.filter(i => i.invite_id !== Number(id));
        renderStoryPanel();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyReady() {
      try {
        const res = await post('/api/fantasy/party/ready');
        partyData = res.party;
        if (friendsOpen) renderFriendsOverlay();
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyLeave() {
      const label = partyData?.leaderId === state.character?.id ? 'Disband Party' : 'Leave Party';
      const ok = await appConfirm('Are you sure you want to ' + label.toLowerCase() + '?', label, 'Stay');
      if (!ok) return;
      try {
        const res = await post('/api/fantasy/party/leave');
        partyData = null;
        _partyInviteList = null;
        stopPartyPolling();
        applyState(res);
        renderStoryPanel();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyKick(id) {
      try {
        const res = await post('/api/fantasy/party/kick', { charId: Number(id) });
        partyData = res.party;
        showToast('info', 'Party', res.message || 'Kicked.');
        renderStoryPanel();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyVoteKick(id) {
      const cs = partyCombatData;
      const target = cs?.players?.[id];
      const ok = await appConfirm(`Vote to kick ${esc(target?.name || 'this player')} from the raid? Majority vote required.`, 'Vote Kick', 'Cancel');
      if (!ok) return;
      try {
        const res = await post('/api/fantasy/party/votekick', { charId: Number(id) });
        showToast(res.kicked ? 'death' : 'info', 'Vote Kick', res.message || 'Vote recorded.');
        if (res.party) partyData = res.party;
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function q1PartyRaidState() {
      try {
        const resp = await fetch('/api/fantasy/party/combat/poll', { credentials: 'include' });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.raidState;
      } catch(e) { return null; }
    }

    // ── Party Combat ──
    function startPartyCombatPolling() {
      // SSE delivers combat state — skip polling if SSE is active
      if (partyEventSource) return;
      stopPartyCombatPolling();
      pollPartyCombat();
      partyCombatPollTimer = setInterval(pollPartyCombat, 3000);
    }
    function stopPartyCombatPolling() {
      if (partyCombatPollTimer) { clearInterval(partyCombatPollTimer); partyCombatPollTimer = null; }
    }
    async function pollPartyCombat() {
      try {
        const resp = await fetch('/api/fantasy/party/combat/poll', { credentials: 'include' });
        if (!resp.ok) { trackPollFailure(); return; }
        const data = await resp.json();
        trackPollSuccess();
        partyCombatData = data.combat;
        partyRaidState = data.raidState;
        if (partyCombatData?.phase === 'wipe') {
          // Party wiped — stop polling, clear state
          stopPartyCombatPolling();
          partyData = null;
          partyCombatData = null;
          partyRaidState = null;
          showToast('death', 'Party Wipe', 'The raid is lost. All party members respawn.');
          const st = await fetch('/api/fantasy/state', { credentials: 'include' }).then(r => r.json());
          if (st) state = { ...state, ...st };
          storyView = 'menu';
        } else if (partyCombatData?.phase === 'victory') {
          // Victory — show result then clear combat
          stopPartyCombatPolling();
        } else if (!partyCombatData && partyRaidState) {
          // Not in combat — stop combat polling, keep raid polling
          stopPartyCombatPolling();
        }
        renderGame();
      } catch (e) { trackPollFailure(); }
    }
    async function partyRaidAdvance() {
      try {
        const res = await post('/api/fantasy/party/raid/advance');
        partyRaidState = res.raidState;
        partyCombatData = res.combat || null;
        partyData = res.party || partyData;
        if (partyCombatData) startPartyCombatPolling();
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    let _raidVoteCast = false;
    async function partyRaidChoice(idx) {
      try {
        const res = await post('/api/fantasy/party/raid/choice', { choiceIdx: Number(idx) });
        partyRaidState = res.raidState;
        if (res.allVoted && partyRaidState?.phase === 'choiceResult') {
          _raidVoteCast = false;
          showToast('info', 'Vote', partyRaidState.lastChoiceOutcome?.success ? 'The party chose wisely!' : 'The vote\'s outcome was... unfortunate.');
        } else {
          _raidVoteCast = true;
          showToast('info', 'Vote', 'Vote cast! Waiting for party...');
        }
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyRaidFloorChoice(choice) {
      try {
        const res = await post('/api/fantasy/party/raid/floor-choice', { choice });
        partyRaidState = res.raidState;
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyRaidDismiss() {
      try {
        const res = await post('/api/fantasy/party/raid/dismiss');
        partyData = null; partyCombatData = null; partyRaidState = null;
        stopPartyCombatPolling(); stopPartyPolling();
        applyState(res);
        storyView = 'menu';
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyCombatAction(type, ability) {
      try {
        const body = { action: type };
        if (ability) body.abilitySlug = ability;

        // Determine target based on ability type
        if (ability && partyCombatData) {
          const me = partyCombatData.players[state.character?.id];
          const cls = gameData.classes.find(x => x.slug === me?.class);
          const abilDef = cls?.abilities?.find(a => a.slug === ability);
          if (abilDef && needsAllyTarget(abilDef.type)) {
            // Ally-targeting ability — use selected ally
            body.targetId = partyTargetAlly ? String(partyTargetAlly) : String(state.character?.id);
          } else {
            // Enemy-targeting — use selected enemy
            body.targetId = partyTargetEnemy || partyCombatData.enemies.find(e => e.hp > 0)?.id;
          }
        } else {
          // Basic attack — target selected enemy
          body.targetId = partyTargetEnemy || partyCombatData?.enemies?.find(e => e.hp > 0)?.id;
        }

        const res = await post('/api/fantasy/party/combat/action', body);
        partyCombatData = res.combat;
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyCombatAck() {
      // After victory, clear combat and advance raid
      partyCombatData = null;
      stopPartyCombatPolling();
      const isLeader = partyData?.leaderId === state.character?.id;
      if (isLeader) {
        await partyRaidAdvance();
      } else {
        renderGame();
      }
    }

    const ALLY_TARGET_TYPES = new Set(['ally-heal', 'ally-restore', 'ally-revive', 'party-heal', 'party-buff', 'party-debuff']);
    const ENEMY_TARGET_TYPES = new Set(['physical', 'magic', 'party-debuff', 'taunt']);
    function needsAllyTarget(type) { return type === 'ally-heal' || type === 'ally-restore' || type === 'ally-revive'; }
    function needsEnemyTarget(type) { return type === 'physical' || type === 'magic' || type === 'party-debuff'; }

    function selectPartyEnemy(id) { partyTargetEnemy = id; partyTargetAlly = null; renderGame(); }
    function selectPartyAlly(id) { partyTargetAlly = Number(id); partyTargetEnemy = null; renderGame(); }

    function renderPartyCombat() {
      const cs = partyCombatData;
      if (!cs) return '';
      const c = state.character;
      const me = cs.players[c.id];
      const CLASS_ICONS = { warrior: '⚔', mage: '🔮', rogue: '🗡', cleric: '✝', ranger: '🏹' };
      const canAct = cs.phase === 'submit' && me && me.hp > 0 && !me.pendingAction;

      // Auto-select first living enemy if none selected
      const livingEnemies = cs.enemies.filter(e => e.hp > 0);
      if (!partyTargetEnemy || !livingEnemies.find(e => e.id === partyTargetEnemy)) {
        partyTargetEnemy = livingEnemies[0]?.id || null;
      }

      let html = '';
      const eyebrow = cs.isBossRoom ? `🔥 PARTY RAID BOSS — FLOOR ${cs.raidFloor || '?'}` : `⚔ PARTY COMBAT — FLOOR ${cs.raidFloor || '?'}`;
      const raidBg = partyRaidState?.raidSlug ? locationImageUrl('raid-' + partyRaidState.raidSlug) : locationImageUrl(c.location);
      html += `<div class="combat-box" style="position:relative;max-height:80vh;display:flex;flex-direction:column">
        <div class="combat-bg"><img src="${raidBg}" alt="" onerror="this.parentElement.style.display='none'"></div>
        <div class="eyebrow" style="position:relative">${eyebrow}</div>
        <div style="overflow-y:auto;flex:1;position:relative">`;

      // ── ENEMIES (clickable for targeting) ──
      html += `<div class="enemy-gallery">`;
      for (const en of cs.enemies) {
        const dead = en.hp <= 0;
        const isTarget = en.id === partyTargetEnemy && !dead;
        const hpPct = Math.max(0, Math.round((en.hp / en.maxHp) * 100));
        const targetClass = isTarget ? ' enemy-card-target' : '';
        const deadClass = dead ? ' enemy-card-dead' : '';
        const clickAttr = !dead && canAct ? `data-action="selectPartyEnemy" data-id="${en.id}" style="cursor:pointer"` : '';
        html += `<div class="enemy-card${targetClass}${deadClass}" ${clickAttr}>
          <div class="enemy-card-name">${en.boss ? '🔥 ' : ''}${esc(en.name)}${dead ? ' ☠' : ''}${isTarget ? ' ◄' : ''}</div>
          ${!dead ? renderEnemyPortrait(en.slug, { dead }) : ''}
          ${!dead ? `<div class="enemy-card-stats">ATK ${en.attack} · DEF ${en.defense} · HP ${en.hp}/${en.maxHp}</div>
          <div class="bar"><div class="fill hp" style="width:${hpPct}%"></div></div>` : ''}
        </div>`;
      }
      html += `</div>`;

      // ── PARTY MEMBERS (clickable for ally targeting) ──
      html += `<div style="margin:12px 0;padding:10px;background:rgba(20,184,166,.04);border:1px solid rgba(20,184,166,.15);border-radius:8px">
        <div class="label" style="margin-bottom:6px;color:#14b8a6">PARTY</div>`;
      for (const [pid, p] of Object.entries(cs.players)) {
        const numPid = Number(pid);
        const isMe = numPid === c.id;
        const hpPct = Math.round((p.hp / p.maxHp) * 100);
        const isDown = p.hp <= 0;
        const isDisconnected = p.lastPoll && (Date.now() - new Date(p.lastPoll).getTime() > 60000);
        const missed = p.missedRounds || 0;
        const isAfk = missed >= 2; // show warning at 2+

        let statusIcon = '⏳';
        let statusColor = '#888';
        if (isDown) { statusIcon = '💀'; statusColor = '#ef4444'; }
        else if (p.pendingAction) { statusIcon = '✓'; statusColor = '#22c55e'; }
        else if (isDisconnected) { statusIcon = '📡'; statusColor = '#ef4444'; }
        else if (isAfk) { statusIcon = '💤'; statusColor = '#f59e0b'; }

        const afkBadge = !isDown && missed > 0 ? `<span style="font-size:.55rem;color:#f59e0b;margin-left:4px" title="Missed ${missed} round${missed!==1?'s':''}">⚠ AFK${missed >= 2 ? ' (' + missed + ')' : ''}</span>` : '';
        const dcBadge = !isDown && isDisconnected ? `<span style="font-size:.55rem;color:#ef4444;margin-left:4px">📡 DC</span>` : '';
        const kickBtn = !isMe && !isDown && (missed >= 2 || isDisconnected) ? `<button class="secondary small" data-action="partyVoteKick" data-num-id="1" data-id="${numPid}" style="font-size:.55rem;padding:1px 5px;margin-left:auto;color:#ef4444;border-color:rgba(239,68,68,.3)" title="Vote to kick">✕ Kick</button>` : '';

        const isAllyTarget = partyTargetAlly === numPid;
        const allyBorder = isAllyTarget ? 'border:2px solid rgba(20,184,166,.6);background:rgba(20,184,166,.08);' : 'border:2px solid transparent;';
        const allyClick = canAct && !isDown ? `data-action="selectPartyAlly" data-id="${numPid}" style="cursor:pointer;${allyBorder}border-radius:6px;padding:4px 6px;margin-bottom:2px;${isMe?'font-weight:700;':''}"` : `style="${allyBorder}border-radius:6px;padding:4px 6px;margin-bottom:2px;${isMe?'font-weight:700;':''}"`;
        html += `<div ${allyClick}>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="color:${statusColor};width:16px">${statusIcon}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:.82rem;display:flex;align-items:center;flex-wrap:wrap">${CLASS_ICONS[p.class]||''} ${esc(p.name)}${isMe ? ' (you)' : ''}${isAllyTarget ? ' ◄' : ''} <span class="muted">Lv${p.level}</span>${afkBadge}${dcBadge}${kickBtn}</div>
              <div style="display:flex;gap:4px;margin-top:2px">
                <div class="bar thin" style="flex:1"><div class="fill hp" style="width:${hpPct}%"></div></div>
                <span style="font-size:.6rem;color:var(--red);width:50px">${p.hp}/${p.maxHp}</span>
              </div>
              <div style="display:flex;gap:4px;margin-top:1px">
                <div class="bar thin" style="flex:1"><div class="fill mp" style="width:${Math.round((p.mp / p.maxMp) * 100)}%"></div></div>
                <span style="font-size:.6rem;color:var(--sky);width:50px">${p.mp}/${p.maxMp}</span>
              </div>
            </div>
          </div>
        </div>`;
      }
      html += `</div>`;

      // ── TARGET HINT ──
      if (canAct) {
        const targetName = partyTargetEnemy ? cs.enemies.find(e => e.id === partyTargetEnemy)?.name : null;
        const allyName = partyTargetAlly ? cs.players[partyTargetAlly]?.name : null;
        html += `<div style="text-align:center;font-size:.75rem;color:var(--muted);margin:4px 0">
          ${targetName ? '⚔ Target: <strong style="color:#fbbf24">' + esc(targetName) + '</strong>' : ''}
          ${allyName ? ' · 💚 Ally: <strong style="color:#14b8a6">' + esc(allyName) + '</strong>' : ''}
          ${!targetName && !allyName ? 'Click an enemy or ally to select a target' : ''}
        </div>`;
      }

      // Round info + timer
      if (cs.phase === 'submit') {
        const deadline = new Date(cs.roundDeadline);
        const secsLeft = Math.max(0, Math.round((deadline.getTime() - Date.now()) / 1000));
        html += `<div style="text-align:center;margin:4px 0;font-size:.82rem;color:var(--muted)">Round ${cs.turn} · ${secsLeft}s remaining</div>`;

        if (canAct) {
          // Basic actions
          html += `<div style="margin:8px 0;display:flex;gap:4px;flex-wrap:wrap">
            <button class="action-btn physical" data-action="partyCombatAction" data-type="attack">⚔ Attack</button>
            <button class="action-btn" data-action="partyCombatAction" data-type="defend">🛡 Defend</button>
          </div>`;
          // Abilities
          const cls = gameData.classes.find(x => x.slug === me.class);
          const activeAbils = (cls?.abilities || []).filter(a => me.activeAbilities.includes(a.slug));
          if (activeAbils.length) {
            html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin:6px 0">`;
            for (const a of activeAbils) {
              const onCd = (me.cooldowns[a.slug] || 0) > 0;
              const cost = getAbilityRankCost(a.cost || 0, (me.abilityRanks || {})[a.slug] || 1);
              const canUse = !onCd && me.mp >= cost;
              const isAllyAbility = needsAllyTarget(a.type);
              const targetLabel = isAllyAbility ? (partyTargetAlly ? '' : ' [select ally]') : '';
              const needsTarget = isAllyAbility && !partyTargetAlly;
              const cdLabel = onCd ? ` [${me.cooldowns[a.slug]}t]` : '';
              html += `<button class="action-btn ${a.type}" data-action="partyCombatAction" data-type="ability" data-ability="${a.slug}" ${canUse && !needsTarget ? '' : 'disabled'} title="${esc(a.description||'')} (${cost} MP)${onCd ? ' CD:'+me.cooldowns[a.slug] : ''}${isAllyAbility ? ' — targets ally' : ''}" style="font-size:.78rem;padding:4px 8px;${onCd ? 'opacity:.45;' : ''}">${esc(a.name)} <span class="muted">${cost}</span>${cdLabel}${targetLabel}</button>`;
            }
            html += `</div>`;
          }
        } else if (me && me.pendingAction) {
          html += `<div style="text-align:center;padding:12px;color:#22c55e;font-weight:600">✓ Action submitted — waiting for party...</div>`;
        } else if (me && me.hp <= 0) {
          html += `<div style="text-align:center;padding:12px;color:#ef4444">💀 You are down. Waiting for combat to end...</div>`;
        }
      }

      // Momentum bar
      if (me && me.hp > 0) {
        const m = me.momentum || 0;
        const tierNames = ['', '', '', 'Warmed Up', 'Warmed Up', 'In The Zone', 'In The Zone', 'Battle Focus', 'Battle Focus', 'Unstoppable', 'Unstoppable'];
        const tierName = tierNames[m] || '';
        const pct = (m / 10) * 100;
        const tierColor = m >= 9 ? '#fbbf24' : m >= 7 ? '#f97316' : m >= 5 ? '#3b82f6' : m >= 3 ? '#22c55e' : 'var(--muted)';
        html += `<div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
            <span class="label" style="margin:0">⚡ Momentum</span>
            <span style="font-size:.72rem;font-family:'Fira Code',monospace;color:${tierColor}">${tierName ? tierName + ' ' : ''}${m}/10</span>
          </div>
          <div class="bar" style="height:6px;margin:0"><div class="fill" style="width:${pct}%;background:linear-gradient(90deg,${tierColor},${tierColor}88);transition:width .4s ease"></div></div>
        </div>`;
      }

      // Round log
      if (cs.roundLog?.length) {
        html += `<div style="margin-top:10px;padding:8px;background:rgba(0,0,0,.2);border-radius:8px;max-height:200px;overflow-y:auto;font-size:.8rem;line-height:1.5">`;
        for (const line of cs.roundLog) html += `<div>${esc(line)}</div>`;
        html += `</div>`;
      }

      // Victory/wipe — sticky at bottom so it's always reachable
      if (cs.phase === 'victory') {
        const isLeader = partyData?.leaderId === c.id;
        const leaderName = (partyData?.members || []).find(m => m.isLeader)?.name || 'the leader';
        html += `</div><div style="position:sticky;bottom:0;padding:12px 16px;background:linear-gradient(to top,rgba(14,12,10,.98) 60%,transparent);text-align:center;z-index:2">
          <div style="color:#22c55e;font-weight:700;font-size:1.1rem;margin-bottom:8px">⚔ Victory!</div>
          ${isLeader
            ? `<button class="primary-action" data-action="partyCombatAck">Continue</button>`
            : `<div class="primary-action" style="pointer-events:none;opacity:.6;background:linear-gradient(135deg,#3a2f20,#4a3a28);cursor:default;font-style:italic">⏳ Waiting for ${esc(leaderName)} to continue...</div>`}
        </div>`;
        // Close the scrollable wrapper
        html += `</div>`;
      } else if (cs.phase === 'wipe') {
        html += `</div><div style="position:sticky;bottom:0;padding:12px 16px;background:linear-gradient(to top,rgba(14,12,10,.98) 60%,transparent);text-align:center;z-index:2">
          <div style="color:#ef4444;font-weight:700;font-size:1.1rem">💀 Party Wipe</div>
        </div></div>`;
      } else {
        html += `</div></div>`;
      }
      return html;
    }

    async function partyInviteFriend(id) {
      try {
        const res = await post('/api/fantasy/party/invite', { charId: Number(id) });
        partyData = res.party;
        _partyInviteList = null;
        showToast('info', 'Party', res.message || 'Invited!');
        renderFriendsOverlay();
        if (storyView === 'raidTower') renderStoryPanel();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyStartRaid() {
      const ok = await appConfirm('Start the raid with your party? All members will be locked in.', 'Start Raid', 'Cancel');
      if (!ok) return;
      try {
        const res = await post('/api/fantasy/party/start');
        partyData = res.party;
        // Re-fetch full state since raid_state changed
        const st = await fetch('/api/fantasy/state', { credentials: 'include' }).then(r => r.json());
        if (st) { state = { ...state, ...st }; }
        startPartyCombatPolling();
        storyView = 'menu';
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    let _partyRaidPickerOpen = false;
    async function togglePartyRaidPicker() {
      if (_partyRaidPickerOpen) { _partyRaidPickerOpen = false; if (friendsOpen) renderFriendsOverlay(); renderGame(); return; }
      if (!raidListData) { await loadRaidList(); }
      _partyRaidPickerOpen = true;
      if (friendsOpen) renderFriendsOverlay();
      renderGame();
    }
    async function partySelectRaid(slug) {
      try {
        const res = await post('/api/fantasy/party/select-raid', { raidSlug: slug });
        partyData = res.party;
        _partyRaidPickerOpen = false;
        showToast('info', 'Lobby', 'Raid lobby opened — invite your party to join.');
        if (friendsOpen) renderFriendsOverlay();
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyCancelLobby() {
      const ok = await appConfirm('Cancel the raid lobby? Everyone will have to rejoin when you pick a new raid.', 'Cancel Lobby', 'Keep');
      if (!ok) return;
      try {
        const res = await post('/api/fantasy/party/cancel-lobby');
        partyData = res.party;
        if (friendsOpen) renderFriendsOverlay();
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function partyJoinLobby() {
      try {
        const res = await post('/api/fantasy/party/join-lobby');
        partyData = res.party;
        if (friendsOpen) renderFriendsOverlay();
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function enterClassTrainer() {
      try {
        const res = await post('/api/fantasy/class-trainer');
        if (!res) return;
        classTrainerData = res.classTrainer;
        // Init academy state for abilities tab
        academyFilter = 'all'; selectedTalent = null; pendingLoadout = null; academyLoadoutMode = 'pve';
        storyView = 'classTrainer';
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function classTrainerAccept(questSlug) {
      try {
        const res = await post('/api/fantasy/class-trainer/accept', { questSlug });
        if (!res) return;
        applyState(res);
        await enterClassTrainer(); // refresh
      } catch (err) { showMessage(err.message, true); }
    }

    async function classTrainerChoice(questSlug, choiceIndex) {
      try {
        const res = await post('/api/fantasy/class-trainer/choice', { questSlug, choiceIndex: Number(choiceIndex) });
        if (!res) return;
        applyState(res);
        if (res.messages) for (const m of res.messages) showMessage(m);
        await enterClassTrainer(); // refresh
      } catch (err) { showMessage(err.message, true); }
    }

    async function classTrainerSetAbility(abilitySlug) {
      try {
        const res = await post('/api/fantasy/class-trainer/set-ability', { abilitySlug });
        if (!res) return;
        applyState(res);
        await enterClassTrainer(); // refresh
      } catch (err) { showMessage(err.message, true); }
    }

    function setClassTrainerTab(tab) { classTrainerTab = tab; renderStoryPanel(); }

    function renderClassTrainerView() {
      if (!classTrainerData) return '<div class="muted">Loading...</div>';
      const ct = classTrainerData;
      const c = state.character;
      const locName = esc(state.location?.name || 'Training Hall');
      const maxRank = ct.maxAbilityRank || 1;
      let html = `<div class="eyebrow">⚔ CLASS TRAINER — ${esc(locName.toUpperCase())}</div>`;
      html += '<h2 style="font-family:Cinzel,serif;margin:8px 0 4px">' + esc(c.class.charAt(0).toUpperCase() + c.class.slice(1)) + ' Training Hall</h2>';
      html += `<div class="muted" style="margin-bottom:14px;font-size:.82rem">✦ ${c.arcane_tokens || 0} Arcane Tokens · Ability Rank Cap: ${maxRank}/5</div>`;

      // Tab bar
      html += `<div class="tab-bar" style="margin-bottom:14px">
        <button class="tab-btn ${classTrainerTab === 'abilities' ? 'active' : ''}" data-action="setClassTrainerTab" data-tab="abilities">✦ Abilities</button>
        <button class="tab-btn ${classTrainerTab === 'quests' ? 'active' : ''}" data-action="setClassTrainerTab" data-tab="quests">📜 Quests</button>
        <button class="tab-btn ${classTrainerTab === 'spec' ? 'active' : ''}" data-action="setClassTrainerTab" data-tab="spec">⚔ Specialization</button>
      </div>`;

      // Abilities tab — reuse existing academy rendering
      if (classTrainerTab === 'abilities') {
        html += renderAcademyView();
        html += '<div style="margin-top:18px"><button class="secondary" data-action="leaveClassTrainer">← Leave</button></div>';
        return html;
      }

      // ── QUESTS TAB ──
      if (classTrainerTab === 'quests') {
        if (ct.quests.length === 0) {
          html += '<div class="muted" style="font-style:italic">No class quests available yet.</div>';
        }
        html += `<div class="muted" style="font-size:.82rem;margin-bottom:12px">Complete class quests at each realm hub to raise your ability rank cap. Current cap: <strong style="color:var(--gold)">Rank ${ct.maxAbilityRank}/5</strong>. After unlocking a new rank, use the Abilities tab to upgrade individual abilities (costs ✦ Tokens).</div>`;
        for (const quest of ct.quests) {
          const statusLabel = quest.status === 'completed' ? '<span style="color:var(--emerald)">✅ Completed</span>'
            : quest.status === 'locked' ? `<span class="muted">🔒 ${quest.requiredLevel ? 'Lv ' + quest.requiredLevel : 'Prerequisite needed'}</span>`
            : quest.status === 'active' ? '<span style="color:var(--gold)">📜 In Progress</span>'
            : '<span style="color:var(--gold)">Available</span>';
          const realmTag = quest.realmIcon ? `<span class="muted" style="font-size:.72rem">${quest.realmIcon} ${esc(quest.locationName || '')}</span>` : '';
          const rankTag = quest.ranksUnlocked ? `<span style="font-size:.72rem;color:var(--gold)">⬆ Unlocks Rank ${quest.ranksUnlocked}</span>` : '';
          const atLocation = quest.location === ct.currentLocation;
          html += `<div style="border:1px solid ${quest.status === 'active' ? 'var(--gold)' : 'var(--line)'};border-radius:10px;padding:12px;margin-bottom:8px;background:${quest.status === 'active' ? 'rgba(214,176,95,.05)' : 'rgba(255,255,255,.02)'}">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">
              <strong>${esc(quest.title)}</strong>
              <div style="display:flex;gap:8px;align-items:center">${realmTag} ${rankTag} ${statusLabel}</div>
            </div>
            <div class="muted" style="font-size:.82rem;margin-top:4px">${esc(quest.description)}</div>
            ${quest.rewards ? `<div style="font-size:.75rem;margin-top:6px;color:var(--muted)">🎁 Rewards: ${[quest.rewards.xp ? quest.rewards.xp + ' XP' : '', quest.rewards.gold ? quest.rewards.gold + 'g' : '', quest.rewards.tokens ? quest.rewards.tokens + ' ✦' : ''].filter(Boolean).join(', ')}${quest.ranksUnlocked ? ' — <span style="color:var(--gold)">unlocks ability upgrades to Rank ' + quest.ranksUnlocked + '</span>' : ''}</div>` : ''}
            ${quest.status === 'available' && atLocation ? '<button class="secondary small" style="margin-top:8px" data-action="classTrainerAccept" data-slug="' + quest.slug + '">Accept Quest</button>' : ''}
            ${quest.status === 'available' && !atLocation ? `<div class="muted" style="font-size:.78rem;margin-top:6px">📍 Travel to ${esc(quest.locationName || quest.location)} to accept this quest.</div>` : ''}
            ${quest.status === 'active' && quest.stageText ? `
              <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
                <div style="font-size:.9rem;margin-bottom:10px;line-height:1.5">${esc(quest.stageText)}</div>
                ${(quest.stageChoices || []).map((ch, i) => `
                  <button class="secondary small" style="display:block;width:100%;text-align:left;margin-bottom:6px;padding:8px 12px" data-action="classTrainerChoice" data-slug="${quest.slug}" data-idx="${i}">${esc(ch.text)}</button>
                `).join('')}
              </div>` : ''}
          </div>`;
        }
      }

      // ── COMPANION TAB ──
      if (classTrainerTab === 'spec') {
        const specTier = state.character?.companion?.specTier || 0;

        if (ct.companion) {
          const comp = ct.companion;
          html += `<div style="border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px;background:rgba(255,255,255,.02)">
            <div class="label" style="margin-bottom:8px">YOUR COMPANION <span style="color:var(--gold)">Tier ${specTier}/4</span></div>
            <div style="display:flex;gap:16px;align-items:flex-start">
              <div style="font-size:2.5rem">${comp.icon}</div>
              <div style="flex:1">
                <div style="font-weight:700;font-size:1.1rem">${esc(comp.name)} <span class="muted" style="font-weight:400;font-size:.82rem">Lv ${comp.level}</span></div>
                <div class="muted" style="font-size:.8rem;margin-top:2px">XP: ${comp.xp} / ${comp.xpNeeded}</div>
                <div class="bar" style="margin-top:4px"><div class="fill" style="width:${Math.min(100, comp.xp / comp.xpNeeded * 100)}%;background:var(--gold)"></div></div>
                <div style="margin-top:10px"><div class="label" style="margin-bottom:6px">ACTIVE ABILITY</div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                    ${comp.abilities.map(a => `<button class="${a.slug === comp.activeAbility ? 'primary-action' : 'secondary'} small" data-action="classTrainerSetAbility" data-slug="${a.slug}">${esc(a.name)}</button>`).join('')}
                  </div>
                </div>
              </div>
            </div>
          </div>`;
        }
        if (ct.classBonus) {
          const cb = ct.classBonus;
          html += `<div style="border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px;background:rgba(255,255,255,.02)">
            <div class="label" style="margin-bottom:8px">YOUR SPECIALIZATION <span style="color:var(--gold)">Tier ${specTier}/4</span></div>
            <div style="display:flex;gap:16px;align-items:flex-start">
              <div style="font-size:2.5rem">${cb.icon}</div>
              <div style="flex:1">
                <div style="font-weight:700;font-size:1.1rem">${esc(cb.name)}</div>
                <div class="muted" style="font-size:.85rem;margin-top:4px;line-height:1.5">${esc(cb.description)}</div>
                ${cb.special ? `<div style="margin-top:8px;padding:8px;border-radius:8px;background:rgba(139,92,246,.08);border:1px solid rgba(139,92,246,.15)">
                  <div style="font-weight:600;font-size:.85rem;color:#a78bfa">${cb.icon} ${esc(cb.special.name)}</div>
                  <div class="muted" style="font-size:.78rem;margin-top:2px">${esc(cb.special.description)} <span style="color:rgba(255,160,60,.8)">(Once per combat)</span></div>
                </div>` : ''}
              </div>
            </div>
          </div>`;
        }

        // Tier progression roadmap
        if (specTier > 0) {
          const specSlug = state.character?.companion?.classBonus || state.character?.companion?.type;
          const tierSource = state.character?.companion?.classBonus
            ? gameData?.classes?.find(cl => cl.abilities.some(a => a.slug))  // not needed, tiers are in classTrainer data
            : null;
          // Get tiers from the class trainer data
          const allTiers = ct.classBonus?.tiers || ct.companion?.tiers || [];
          if (allTiers.length > 0) {
            html += `<div class="label" style="margin:16px 0 8px">TIER PROGRESSION</div>`;
            for (let i = 0; i < allTiers.length; i++) {
              const t = allTiers[i];
              const active = i < specTier;
              const current = i === specTier - 1;
              const locked = i >= specTier;
              const borderColor = current ? 'var(--gold)' : active ? 'var(--emerald)' : 'var(--line)';
              const bg = current ? 'rgba(214,176,95,.06)' : active ? 'rgba(46,139,87,.04)' : 'rgba(255,255,255,.01)';
              html += `<div style="border:1px solid ${borderColor};border-radius:8px;padding:10px 12px;margin-bottom:6px;background:${bg};${locked ? 'opacity:.5' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <strong style="font-size:.88rem">${active ? '✅' : '🔒'} Tier ${i + 1}</strong>
                  ${current ? '<span style="font-size:.72rem;color:var(--gold);font-weight:600">CURRENT</span>' : ''}
                </div>
                <div class="muted" style="font-size:.8rem;margin-top:4px;line-height:1.4">${esc(t.desc)}</div>
              </div>`;
            }
          }
        }

        if (!ct.companion && !ct.classBonus) {
          html += '<div class="muted" style="font-style:italic;padding:16px 0">Complete your first class quest at Thornwall to bond a companion or choose a specialization.</div>';
        }
        // Respec button
        if (ct.companion || ct.classBonus) {
          const tokens = state.character?.arcane_tokens || 0;
          const cost = 100;
          html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
            <button class="danger small" data-action="classTrainerRespec" ${tokens < cost ? 'disabled' : ''}>🔄 Full Respec (${cost} ✦) — resets spec, ranks, and all class quests</button>
            ${tokens < cost ? `<span class="muted" style="font-size:.75rem;margin-left:8px">Need ${cost - tokens} more tokens</span>` : ''}
          </div>`;
        }
      }

      html += '<div style="margin-top:16px"><button class="secondary" data-action="leaveClassTrainer">← Leave</button></div>';
      return html;
    }
    function leaveClassTrainer() { storyView = 'menu'; classTrainerData = null; pendingLoadout = null; academyLoadoutMode = 'pve'; renderStoryPanel(); }

    // ═══════════════════════════════════════════
    //  PROGRESSION — Achievements, Codex, Titles, Weekly, Feed
    // ═══════════════════════════════════════════
    let progressionData = null;
    let progressionTab = 'achievements';

    async function enterProgression() {
      try {
        const [achRes, codexRes, weeklyRes, feedRes] = await Promise.all([
          api('/api/fantasy/achievements', { method: 'POST' }),
          api('/api/fantasy/codex', { method: 'POST' }),
          api('/api/fantasy/weekly-quests', { method: 'POST' }),
          api('/api/fantasy/world-feed'),
        ]);
        progressionData = { achievements: achRes, codex: codexRes, weekly: weeklyRes, feed: feedRes };
        storyView = 'progression';
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    function setProgressionTab(tab) { progressionTab = tab; renderStoryPanel(); }

    async function claimWeeklyQuest(slug) {
      try {
        const res = await post('/api/fantasy/weekly-quests/claim', { questSlug: slug });
        if (!res) return;
        applyState(res);
        if (res.messages) showMessage(res.messages[0]);
        await enterProgression();
      } catch (err) { showMessage(err.message, true); }
    }

    async function setTitle(title) {
      try {
        const res = await post('/api/fantasy/set-title', { title });
        if (!res) return;
        applyState(res);
        if (res.messages) showMessage(res.messages[0]);
        await enterProgression();
      } catch (err) { showMessage(err.message, true); }
    }

    async function claimDailyLogin() {
      try {
        const res = await post('/api/fantasy/daily-login');
        if (!res) return;
        applyState(res);
        if (res.messages) showMessage(res.messages[0]);
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    // ══════════════════════════════════════════
    //  CODEX PANEL
    // ══════════════════════════════════════════
    let codexSection = 'sections'; // 'sections'|'guide'|'bestiary'|'items'|'combos'|'quests'|'dungeons'|'locations'
    let codexSubItem = null; // slug of selected item within a section
    let codexData = null; // codex discovery data from API

    async function enterCodex() {
      try {
        const res = await api('/api/fantasy/codex', { method: 'POST' });
        codexData = res;
        codexSection = 'sections';
        codexSubItem = null;
        renderCodexModal();
      } catch (err) { showMessage(err.message, true); }
    }
    function leaveCodex() {
      codexData = null;
      const el = document.getElementById('codexOverlay');
      if (el) el.remove();
    }
    function codexBack() {
      if (codexSubItem) { codexSubItem = null; renderCodexModal(); }
      else if (codexSection !== 'sections') { codexSection = 'sections'; codexSubItem = null; renderCodexModal(); }
      else { leaveCodex(); }
    }
    function codexNav(section, sub) { codexSection = section; codexSubItem = sub || null; renderCodexModal(); }

    function renderCodexModal() {
      let overlay = document.getElementById('codexOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'codexOverlay';
        overlay.className = 'inv-overlay';
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) leaveCodex(); });
        document.body.appendChild(overlay);
      }
      const content = renderCodexView();
      overlay.innerHTML = `
        <div class="inv-modal">
          <div class="inv-header">
            <h3 style="margin:0;font-family:Cinzel,serif;color:var(--gold)">📖 Codex</h3>
            <button class="secondary small" data-action="leaveCodex">✕ Close</button>
          </div>
          <div style="flex:1;overflow-y:auto;padding:16px 20px">${content}</div>
        </div>`;
    }

    function renderCodexView() {
      if (!codexData) return '<div class="muted">Loading...</div>';
      const c = state.character;
      const disc = codexData.codex || {};
      const guide = gameData.codexGuide || [];
      const enemies = gameData.enemyDefs || {};
      const combos = gameData.combos || [];
      const items = gameData.items || {};
      const locations = gameData.locations || [];
      const dungeons = gameData.dungeonConfigs || {};

      // Discovered sets for quick lookup
      const discSlugs = {};
      for (const cat of Object.keys(disc)) {
        discSlugs[cat] = new Set((disc[cat] || []).map(e => e.slug));
      }
      const discEnemy = discSlugs.enemy || new Set();
      const discBoss = discSlugs.boss || new Set();
      const discItem = discSlugs.item || new Set();
      const discMythic = discSlugs.mythic || new Set();
      const discCombo = discSlugs.combo || new Set();
      const discQuest = discSlugs.quest || new Set();
      const discDungeon = discSlugs.dungeon || new Set();
      const discLocation = discSlugs.location || new Set();

      let html = '';

      // ── BREADCRUMB ──
      const crumbs = ['<span data-action="codexNav" data-slug="sections" style="cursor:pointer;color:var(--gold)">📖 Codex</span>'];
      if (codexSection !== 'sections') {
        const secNames = { guide:'📚 Guide', bestiary:'⚔ Bestiary', items:'📦 Items', combos:'⚡ Combos', quests:'📜 Quests', dungeons:'🏰 Dungeons', raids:'🕳 Raids', locations:'📍 Locations' };
        crumbs.push(`<span data-action="codexNav" data-slug="${codexSection}" style="cursor:pointer;color:var(--gold)">${secNames[codexSection] || codexSection}</span>`);
      }
      if (codexSubItem) crumbs.push(`<span class="muted">${esc(codexSubItem)}</span>`);
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-size:.78rem">${crumbs.join(' <span class="muted">›</span> ')}</div>
        <button class="secondary small" data-action="codexBack">← Back</button>
      </div>`;

      // ── SECTIONS LIST ──
      if (codexSection === 'sections') {
        const totalEnemies = Object.keys(enemies).length;
        const totalBosses = Object.values(enemies).filter(e => e.boss).length;
        const totalCombos = combos.length;
        const classCombos = combos.filter(cb => cb.class === c.class).length;
        const classComboDisc = combos.filter(cb => cb.class === c.class && discCombo.has(cb.slug)).length;
        html += '<div class="eyebrow">📖 CODEX</div>';
        html += '<div style="display:grid;gap:8px;margin-top:12px">';
        const sections = [
          { slug:'guide', icon:'📚', name:'Game Guide', desc:'Learn how every system works', count: guide.length + ' pages' },
          { slug:'bestiary', icon:'⚔', name:'Bestiary', desc:'Enemies and bosses you\'ve encountered', count: `${discEnemy.size + discBoss.size}/${totalEnemies} discovered` },
          { slug:'items', icon:'📦', name:'Item Catalog', desc:'Equipment, consumables, and materials', count: `${discItem.size + discMythic.size} discovered` },
          { slug:'combos', icon:'⚡', name:'Ability Combos', desc:'Discover powerful ability sequences', count: `${classComboDisc}/${classCombos} class combos` },
          { slug:'quests', icon:'📜', name:'Quests', desc:'Your quest journal', count: `${discQuest.size} completed` },
          { slug:'dungeons', icon:'🏰', name:'Dungeons', desc:'Dungeon records and mechanics', count: `${discDungeon.size} cleared` },
          { slug:'raids', icon:'🕳', name:'Raids', desc:'Raid tower encounters, bosses, and loot', count: `${(codexData.raidRuns||[]).filter(r=>Number(r.clears)>0).length} cleared` },
          { slug:'locations', icon:'📍', name:'Locations', desc:'Places you\'ve visited', count: `${discLocation.size}/${locations.length} visited` },
        ];
        for (const s of sections) {
          html += `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;cursor:pointer;background:rgba(255,255,255,.02)" data-action="codexNav" data-slug="${s.slug}">
            <span style="font-size:1.4rem">${s.icon}</span>
            <div style="flex:1"><strong>${s.name}</strong><div class="muted" style="font-size:.78rem">${s.desc}</div></div>
            <span class="muted" style="font-size:.75rem;white-space:nowrap">${s.count}</span>
            <span class="muted">›</span>
          </div>`;
        }
        html += '</div>';
        return html;
      }

      // ── GUIDE SECTION ──
      if (codexSection === 'guide') {
        if (codexSubItem) {
          const page = guide.find(g => g.slug === codexSubItem);
          if (page) {
            html += `<div class="eyebrow">${page.icon} ${esc(page.title).toUpperCase()}</div>`;
            html += `<div style="line-height:1.7;font-size:.9rem">${page.content}</div>`;
          }
        } else {
          html += '<div class="eyebrow">📚 GAME GUIDE</div>';
          html += '<div style="display:grid;gap:6px;margin-top:10px">';
          for (const page of guide) {
            html += `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;cursor:pointer;background:rgba(255,255,255,.02)" data-action="codexNav" data-slug="guide" data-sub="${page.slug}">
              <span style="font-size:1.1rem">${page.icon}</span>
              <strong style="font-size:.88rem">${esc(page.title)}</strong>
              <span class="muted" style="margin-left:auto">›</span>
            </div>`;
          }
          html += '</div>';
        }
        return html;
      }

      // ── BESTIARY SECTION ──
      if (codexSection === 'bestiary') {
        const allEnemies = Object.values(enemies).sort((a,b) => a.level - b.level || a.name.localeCompare(b.name));
        if (codexSubItem) {
          const en = enemies[codexSubItem];
          const discEntry = [...(disc.enemy||[]), ...(disc.boss||[])].find(e => e.slug === codexSubItem);
          if (en && discEntry) {
            const locName = (locations.find(l => l.slug === en.location) || {}).name || en.location;
            html += `<div class="eyebrow">${en.boss ? '🔥 BOSS' : '⚔ ENEMY'}</div>`;
            html += `<h3 style="margin:4px 0">${esc(en.name)}</h3>`;
            html += `<div class="muted" style="margin-bottom:10px">Level ${en.level} · ${locName}${en.boss ? ' · Boss' : ''}</div>`;
            html += `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
              <div class="statcard"><div class="label">HP</div><div class="value">${en.hp}</div></div>
              <div class="statcard"><div class="label">ATK</div><div class="value">${en.attack}</div></div>
              <div class="statcard"><div class="label">DEF</div><div class="value">${en.defense}</div></div>
            </div>`;
            html += `<div style="font-size:.85rem"><strong>Rewards:</strong> ${en.xp} XP · ${en.gold} Gold</div>`;
            html += `<div style="font-size:.85rem;margin-top:6px"><strong>Kills:</strong> ${discEntry.count} <span class="muted">· First seen: ${new Date(discEntry.firstSeen).toLocaleDateString()}</span></div>`;
          }
        } else {
          html += '<div class="eyebrow">⚔ BESTIARY</div>';
          html += `<div class="muted" style="margin-bottom:10px;font-size:.82rem">${discEnemy.size + discBoss.size}/${allEnemies.length} discovered</div>`;
          html += '<div style="display:grid;gap:4px">';
          for (const en of allEnemies) {
            const found = discEnemy.has(en.slug) || discBoss.has(en.slug);
            if (found) {
              const entry = [...(disc.enemy||[]), ...(disc.boss||[])].find(e => e.slug === en.slug);
              html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;cursor:pointer;background:rgba(255,255,255,.02)" data-action="codexNav" data-slug="bestiary" data-sub="${en.slug}">
                <span style="font-size:.9rem">${en.boss ? '🔥' : '⚔'}</span>
                <span style="flex:1;font-size:.85rem"><strong>${esc(en.name)}</strong> <span class="muted">Lv${en.level}</span></span>
                <span class="muted" style="font-size:.72rem">×${entry?.count || 0}</span>
                <span class="muted">›</span>
              </div>`;
            } else {
              html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;opacity:.35">
                <span style="font-size:.9rem">❓</span>
                <span style="flex:1;font-size:.85rem">??? <span class="muted">Lv${en.level}</span></span>
              </div>`;
            }
          }
          html += '</div>';
        }
        return html;
      }

      // ── ITEMS SECTION ──
      if (codexSection === 'items') {
        const allItems = Object.entries(items).map(([slug, item]) => ({ slug, ...item }));
        const slots = ['weapon','shield','body','helmet','gloves','boots','amulet','ring','trinket','consumable','material','gem'];
        if (codexSubItem) {
          const item = items[codexSubItem];
          if (item) {
            const rarityColors = { common:'#aaa', uncommon:'#2e8b57', rare:'#4682b4', epic:'#9068d0', legendary:'#b8860b', mythic:'#dc2626' };
            html += `<div class="eyebrow">📦 ITEM</div>`;
            html += `<h3 style="margin:4px 0;color:${rarityColors[item.rarity]||'#fff'}">${esc(item.name)}</h3>`;
            html += `<div class="muted" style="margin-bottom:10px">${item.rarity} ${item.type}</div>`;
            if (item.stats) {
              html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">';
              for (const [k,v] of Object.entries(item.stats)) html += `<span class="talent-detail-tag">${k === 'attack' ? 'ATK' : k === 'defense' ? 'DEF' : k.toUpperCase()} +${v}</span>`;
              html += '</div>';
            }
            if (item.description) html += `<div style="font-size:.85rem;font-style:italic;margin-bottom:8px">${esc(item.description)}</div>`;
            if (item.cost) html += `<div style="font-size:.85rem">💰 Buy: ${item.cost}g · Sell: ${item.sell || '—'}g</div>`;
          }
        } else {
          html += '<div class="eyebrow">📦 ITEM CATALOG</div>';
          html += `<div class="muted" style="margin-bottom:10px;font-size:.82rem">${discItem.size + discMythic.size} items discovered</div>`;
          for (const slot of slots) {
            const slotItems = allItems.filter(i => i.type === slot);
            if (!slotItems.length) continue;
            const discCount = slotItems.filter(i => discItem.has(i.slug) || discMythic.has(i.slug)).length;
            html += `<div style="margin-bottom:8px"><div class="label" style="margin-bottom:4px">${slot.toUpperCase()} (${discCount}/${slotItems.length})</div>`;
            html += '<div style="display:flex;flex-wrap:wrap;gap:4px">';
            const rarityOrder = { common:0, uncommon:1, rare:2, epic:3, legendary:4, mythic:5 };
            slotItems.sort((a,b) => (rarityOrder[a.rarity]||0) - (rarityOrder[b.rarity]||0));
            for (const item of slotItems) {
              const found = discItem.has(item.slug) || discMythic.has(item.slug);
              const rarityColors = { common:'#aaa', uncommon:'#2e8b57', rare:'#4682b4', epic:'#9068d0', legendary:'#b8860b', mythic:'#dc2626' };
              if (found) {
                html += `<span style="font-size:.78rem;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid var(--line);cursor:pointer;color:${rarityColors[item.rarity]||'#fff'}" data-action="codexNav" data-slug="items" data-sub="${item.slug}">${esc(item.name)}</span>`;
              } else {
                html += `<span style="font-size:.78rem;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.02);border:1px solid var(--line);opacity:.3">???</span>`;
              }
            }
            html += '</div></div>';
          }
        }
        return html;
      }

      // ── COMBOS SECTION ──
      if (codexSection === 'combos') {
        const classes = ['warrior','mage','rogue','cleric','ranger'];
        html += '<div class="eyebrow">⚡ ABILITY COMBOS</div>';
        html += `<div class="muted" style="margin-bottom:12px;font-size:.82rem">Discover combos by using the right ability sequences in combat.</div>`;
        for (const cls of classes) {
          const classCombos = combos.filter(cb => cb.class === cls);
          if (!classCombos.length) continue;
          const discCount = classCombos.filter(cb => discCombo.has(cb.slug)).length;
          const isMine = c.class === cls;
          html += `<div style="margin-bottom:14px${isMine ? ';border:1px solid rgba(214,176,95,.2);border-radius:10px;padding:10px;background:rgba(214,176,95,.03)' : ''}">`;
          html += `<div class="label" style="margin-bottom:6px">${cls.toUpperCase()} ${isMine ? '(your class)' : ''} — ${discCount}/${classCombos.length}</div>`;
          for (const cb of classCombos) {
            if (discCombo.has(cb.slug)) {
              html += `<div style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:4px;background:rgba(255,255,255,.02)">
                <div style="font-weight:600;font-size:.88rem">⚡ ${esc(cb.name)}</div>
                <div style="font-size:.82rem;color:var(--gold);margin-top:2px">${esc(cb.first.replace(/-/g,' '))} → ${esc(cb.second.replace(/-/g,' '))}</div>
                <div class="muted" style="font-size:.78rem;margin-top:4px">${esc(cb.description)}</div>
              </div>`;
            } else {
              html += `<div style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:4px;opacity:.35">
                <div style="font-weight:600;font-size:.88rem">❓ ???</div>
                <div class="muted" style="font-size:.82rem;margin-top:2px">??? → ???</div>
              </div>`;
            }
          }
          html += '</div>';
        }
        return html;
      }

      // ── QUESTS SECTION ──
      if (codexSection === 'quests') {
        html += '<div class="eyebrow">📜 QUESTS</div>';
        const questEntries = disc.quest || [];
        if (questEntries.length === 0) html += '<div class="muted" style="font-style:italic">No quests completed yet.</div>';
        for (const q of questEntries) {
          html += `<div style="padding:6px 10px;border:1px solid var(--line);border-radius:6px;margin-bottom:4px;background:rgba(255,255,255,.02)">
            <strong style="font-size:.85rem">${esc(q.name)}</strong>
            <span class="muted" style="font-size:.72rem;margin-left:8px">Completed ${new Date(q.firstSeen).toLocaleDateString()}</span>
          </div>`;
        }
        return html;
      }

      // ── DUNGEONS SECTION ──
      if (codexSection === 'dungeons') {
        html += '<div class="eyebrow">🏰 DUNGEONS</div>';
        const dungeonEntries = disc.dungeon || [];
        const dungeonLocs = locations.filter(l => l.type === 'dungeon');
        for (const dl of dungeonLocs) {
          const entry = dungeonEntries.find(e => e.slug === dl.slug);
          const dc = dungeons[dl.slug];
          if (entry) {
            const mechDesc = dc?.mechanic?.name ? `${dc.mechanic.name} — ${dc.mechanic.description || ''}` : '';
            const bossSlug = dc?.boss || '';
            const bossEnemy = bossSlug ? enemies[bossSlug] : null;
            const bossName = bossEnemy?.name || bossSlug;
            html += `<div style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;background:rgba(255,255,255,.02)">
              <strong>${esc(dl.name)}</strong>
              <div style="font-size:.82rem;margin-top:4px">Clears: ${entry.count} · First: ${new Date(entry.firstSeen).toLocaleDateString()}</div>
              ${mechDesc ? `<div style="font-size:.78rem;color:rgba(255,160,60,.85);margin-top:4px">⚠ ${esc(mechDesc)}</div>` : ''}
              ${bossSlug ? `<div style="font-size:.82rem;margin-top:4px">🔥 Boss: ${esc(bossName)}</div>` : ''}
            </div>`;
          } else {
            html += `<div style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;opacity:.35">
              <strong>???</strong> <span class="muted">Undiscovered</span>
            </div>`;
          }
        }
        return html;
      }

      // ── RAIDS SECTION ──
      if (codexSection === 'raids') {
        const raidDefs = gameData.raidDefs || {};
        const raidRuns = codexData.raidRuns || [];
        const allItems = gameData.items || {};
        const diffColors = { easy: '#22c55e', medium: '#f59e0b', hard: '#ef4444' };

        if (codexSubItem) {
          // Raid detail view
          const rd = raidDefs[codexSubItem];
          if (!rd) return html + '<div class="muted">Unknown raid.</div>';
          const run = raidRuns.find(r => r.raid_slug === rd.slug);
          const diffColor = diffColors[rd.difficulty] || '#888';

          html += `<div class="eyebrow">${rd.icon} ${esc(rd.name)}</div>`;
          html += `<div style="display:flex;gap:10px;align-items:center;margin:8px 0">
            <span style="background:${diffColor};color:#000;padding:2px 10px;border-radius:20px;font-size:.72rem;font-weight:800">${(rd.difficulty||'').toUpperCase()}</span>
            <span class="muted" style="font-size:.82rem">${rd.floorCount} Floors · Level ${rd.levelReq}+</span>
          </div>`;
          html += `<div class="muted" style="line-height:1.6;margin:10px 0">${esc(rd.description)}</div>`;

          // Run stats
          if (run) {
            html += `<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;margin:12px 0">
              <div class="label" style="margin-bottom:6px">YOUR RECORDS</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:.85rem">
                <div>Attempts: <strong>${run.attempts}</strong></div>
                <div>Clears: <strong style="color:#22c55e">${run.clears}</strong></div>
                <div>Best Floor: <strong>${run.best_floor}</strong></div>
                ${run.first_clear ? `<div>First Clear: <strong>${new Date(run.first_clear).toLocaleDateString()}</strong></div>` : ''}
              </div>
            </div>`;
          } else {
            html += `<div class="muted" style="margin:12px 0;font-style:italic">Not yet attempted.</div>`;
          }

          // Floors
          html += `<div class="label" style="margin:14px 0 8px">FLOORS</div>`;
          for (const fl of (rd.floors || [])) {
            html += `<div style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:5px;background:rgba(255,255,255,.02)">
              <strong>Floor ${fl.floor}: ${esc(fl.name)}</strong>
              ${fl.bossName ? `<div class="muted" style="font-size:.8rem;margin-top:2px">🔥 Boss: ${esc(fl.bossName)}</div>` : ''}
            </div>`;
          }

          // Enemies
          if (rd.enemies?.length) {
            html += `<div class="label" style="margin:14px 0 8px">ENEMIES</div>`;
            for (const en of rd.enemies) {
              html += `<div style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:5px;background:rgba(255,255,255,.02)">
                <strong>${esc(en.name)}</strong> <span class="muted">Lv${en.level}</span>
                <div class="muted" style="font-size:.8rem;margin-top:2px">${esc(en.description || '')}</div>
              </div>`;
            }
          }

          // Exclusive drops
          const raidDrops = Object.entries(allItems).filter(([, it]) => (it.rarity === 'legendary' || it.rarity === 'mythic' || it.rarity === 'exotic') && it.description?.toLowerCase().includes(rd.name.split(' ').pop().toLowerCase()));
          // Better: find items from raid-depths files
          const raidItemSlugs = Object.entries(allItems).filter(([slug, it]) => slug.includes('ashenmaw') || slug.includes('wellspring') || slug.includes('thessaly') || slug.includes('castellus') || slug.includes('oathbreaker') || slug.includes('drowned') || slug.includes('silenced') || slug.includes('bone-chorus') || slug.includes('crypt-warden-g') || slug.includes('bone-amalgam-r') || slug.includes('shade-whisper') || slug.includes('ashenmaw-treads'));
          if (raidItemSlugs.length) {
            html += `<div class="label" style="margin:14px 0 8px">EXCLUSIVE DROPS</div>`;
            for (const [slug, it] of raidItemSlugs) {
              const classLabel = it.classReq ? `<span style="color:#14b8a6;font-size:.72rem"> ${it.classReq}</span>` : '';
              html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border:1px solid var(--line);border-radius:6px;margin-bottom:4px">
                <span class="rarity-${it.rarity}" style="font-weight:600">${esc(it.name)}${classLabel}</span>
                <span class="muted" style="font-size:.72rem">${it.type} · ${it.rarity}</span>
              </div>`;
            }
          }
          return html;
        }

        // Raid list
        html += '<div class="eyebrow">🕳 RAIDS</div>';
        const raidList = Object.values(raidDefs);
        if (raidList.length === 0) {
          html += '<div class="muted" style="margin-top:12px">No raids discovered yet.</div>';
          return html;
        }
        for (const rd of raidList) {
          const run = raidRuns.find(r => r.raid_slug === rd.slug);
          const cleared = run && Number(run.clears) > 0;
          const diffColor = diffColors[rd.difficulty] || '#888';
          html += `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;cursor:pointer;background:rgba(255,255,255,.02)" data-action="codexNav" data-slug="raids" data-sub="${rd.slug}">
            <span style="font-size:1.3rem">${rd.icon}</span>
            <div style="flex:1">
              <strong>${esc(rd.name)}</strong>
              <div class="muted" style="font-size:.78rem">${rd.floorCount} floors · Level ${rd.levelReq}+ · <span style="color:${diffColor}">${(rd.difficulty||'').toUpperCase()}</span></div>
            </div>
            <div style="text-align:right;font-size:.78rem">
              ${cleared ? `<div style="color:#22c55e">✅ ${run.clears}× cleared</div>` : run ? `<div class="muted">${run.attempts} attempts</div>` : '<span class="muted">—</span>'}
            </div>
            <span class="muted">›</span>
          </div>`;
        }
        return html;
      }

      // ── LOCATIONS SECTION ──
      if (codexSection === 'locations') {
        const locMeta = gameData.locationMeta || {};
        const realmsData = gameData.realms || [];
        const typeIcon = t => ({ town:'🏘', wild:'⚔', dungeon:'🏰' }[t] || '📍');

        if (codexSubItem) {
          // Location detail view
          const loc = locations.find(l => l.slug === codexSubItem);
          if (!loc) return html + '<div class="muted">Unknown location.</div>';
          const meta = locMeta[loc.slug] || {};
          const dconf = dungeons[loc.slug];
          const realmDef = realmsData.find(r => r.slug === (loc.realm || 'ashlands'));

          html += `<div class="eyebrow">${typeIcon(loc.type)} ${esc(loc.name).toUpperCase()}</div>`;
          html += `<div style="display:flex;gap:8px;align-items:center;margin:6px 0 12px">
            <span style="font-size:.82rem;padding:2px 10px;border-radius:20px;border:1px solid var(--line);background:rgba(255,255,255,.04)">${loc.type}</span>
            ${meta.threatLevel ? `<span class="muted" style="font-size:.82rem">Lv ${meta.threatLevel}</span>` : ''}
            ${realmDef ? `<span class="muted" style="font-size:.82rem">${realmDef.icon} ${esc(realmDef.name)}</span>` : ''}
          </div>`;
          if (loc.description) html += `<div style="font-size:.85rem;font-style:italic;line-height:1.6;margin-bottom:14px;color:var(--muted)">${esc(loc.description)}</div>`;

          // Services
          if (loc.type === 'town') {
            const services = [];
            if (meta.hasShop) services.push('🏪 Shop');
            if (meta.hasInn) services.push('🏨 Inn');
            services.push('🏛 Auction House', '🏟 Arena');
            html += `<div style="margin-bottom:14px"><div class="label" style="margin-bottom:6px">SERVICES</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px">${services.map(s =>
                `<span style="font-size:.78rem;padding:4px 10px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid var(--line)">${s}</span>`
              ).join('')}</div></div>`;
          }

          // Can explore
          if (meta.canExplore) {
            html += `<div style="font-size:.82rem;margin-bottom:10px;color:var(--emerald)">🌿 Explorable — encounter enemies and events here</div>`;
          }

          // Dungeon info
          if (dconf) {
            html += `<div style="margin-bottom:14px;padding:10px;border:1px solid rgba(255,160,60,.2);border-radius:8px;background:rgba(255,160,60,.03)">
              <div class="label" style="margin-bottom:4px">DUNGEON</div>
              <div style="font-size:.82rem">${dconf.minRooms}-${dconf.maxRooms} rooms</div>
              ${dconf.mechanic ? `<div style="font-size:.78rem;color:rgba(255,160,60,.85);margin-top:4px">⚠ ${esc(dconf.mechanic.name)} — ${esc(dconf.mechanic.description || '')}</div>` : ''}
            </div>`;
          }

          // Enemies (show discovered, ?? for undiscovered)
          if (meta.enemies?.length) {
            const nonBoss = meta.enemies.filter(e => !e.boss);
            const bosses = meta.enemies.filter(e => e.boss);

            if (nonBoss.length) {
              html += `<div style="margin-bottom:14px"><div class="label" style="margin-bottom:6px">ENEMIES</div>`;
              for (const en of nonBoss) {
                const found = discEnemy.has(en.slug);
                if (found) {
                  html += `<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--line);border-radius:6px;margin-bottom:3px;background:rgba(255,255,255,.02);cursor:pointer" data-action="codexNav" data-slug="bestiary" data-sub="${en.slug}">
                    <span style="font-size:.8rem">⚔</span>
                    <span style="flex:1;font-size:.82rem"><strong>${esc(en.name)}</strong> <span class="muted">Lv${en.level}</span></span>
                    <span class="muted">›</span>
                  </div>`;
                } else {
                  html += `<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--line);border-radius:6px;margin-bottom:3px;opacity:.35">
                    <span style="font-size:.8rem">❓</span>
                    <span style="font-size:.82rem">??? <span class="muted">Lv${en.level}</span></span>
                  </div>`;
                }
              }
              html += `</div>`;
            }

            if (bosses.length) {
              const rarityColors = { common:'#aaa', uncommon:'#2e8b57', rare:'#4682b4', epic:'#9068d0', legendary:'#b8860b', mythic:'#dc2626', exotic:'#14b8a6' };
              html += `<div style="margin-bottom:14px"><div class="label" style="margin-bottom:6px">BOSSES</div>`;
              for (const en of bosses) {
                const found = discBoss.has(en.slug) || discEnemy.has(en.slug);
                const fullEnemy = enemies[en.slug];
                if (found && fullEnemy) {
                  html += `<div style="padding:10px 12px;border:1px solid rgba(220,38,38,.2);border-radius:8px;margin-bottom:6px;background:rgba(220,38,38,.03)">
                    <div style="display:flex;align-items:center;gap:8px;cursor:pointer" data-action="codexNav" data-slug="bestiary" data-sub="${en.slug}">
                      <span style="font-size:.9rem">🔥</span>
                      <strong style="font-size:.88rem">${esc(en.name)}</strong>
                      <span class="muted" style="font-size:.78rem">Lv${en.level}</span>
                      <span class="muted" style="margin-left:auto">›</span>
                    </div>
                    <div class="muted" style="font-size:.75rem;margin-top:3px">HP ${fullEnemy.hp} · ATK ${fullEnemy.attack} · DEF ${fullEnemy.defense}</div>`;

                  // Material drops
                  if (en.materialDrops?.length) {
                    html += `<div style="margin-top:6px"><span style="font-size:.7rem;color:var(--muted)">Material Drops:</span>
                      <div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:2px">`;
                    for (const d of en.materialDrops) {
                      const mat = items[d.item];
                      const name = mat?.name || d.item;
                      html += `<span style="font-size:.68rem;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,.04);border:1px solid var(--line)">${esc(name)} <span class="muted">${d.chance}%</span></span>`;
                    }
                    html += `</div></div>`;
                  }

                  // Recipe drops
                  if (en.recipeDrops?.length) {
                    html += `<div style="margin-top:4px"><span style="font-size:.7rem;color:var(--muted)">Recipe Drops:</span>
                      <div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:2px">`;
                    for (const d of en.recipeDrops) {
                      const scroll = items[d.recipe];
                      const name = scroll?.name || d.recipe;
                      html += `<span style="font-size:.68rem;padding:2px 6px;border-radius:4px;background:rgba(184,134,11,.08);border:1px solid rgba(184,134,11,.2);color:var(--gold)">${esc(name)} <span style="opacity:.7">${d.chance}%</span></span>`;
                    }
                    html += `</div></div>`;
                  }

                  html += `</div>`;
                } else {
                  html += `<div style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;opacity:.35">
                    <div style="display:flex;align-items:center;gap:8px">
                      <span style="font-size:.9rem">❓</span>
                      <span style="font-size:.88rem">??? Boss <span class="muted">Lv${en.level}</span></span>
                    </div>
                  </div>`;
                }
              }
              html += `</div>`;
            }
          }

          // Connected locations
          if (loc.connections?.length) {
            html += `<div style="margin-bottom:10px"><div class="label" style="margin-bottom:6px">CONNECTIONS</div>
              <div style="display:flex;flex-wrap:wrap;gap:4px">`;
            for (const conn of loc.connections) {
              const cl = locations.find(l => l.slug === conn);
              const found = discLocation.has(conn);
              if (cl && found) {
                html += `<span style="font-size:.78rem;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid var(--line);cursor:pointer" data-action="codexNav" data-slug="locations" data-sub="${conn}">${typeIcon(cl.type)} ${esc(cl.name)}</span>`;
              } else {
                html += `<span style="font-size:.78rem;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.02);border:1px solid var(--line);opacity:.35">❓ ???</span>`;
              }
            }
            html += `</div></div>`;
          }

          return html;
        }

        // Location list — grouped by realm
        html += '<div class="eyebrow">📍 LOCATIONS</div>';
        html += `<div class="muted" style="margin-bottom:12px;font-size:.82rem">${discLocation.size}/${locations.length} discovered</div>`;

        const realmOrder = realmsData.length ? realmsData : [{ slug: 'ashlands', name: 'The Ashlands', icon: '🏔' }];
        for (const realm of realmOrder) {
          const realmLocs = locations.filter(l => (l.realm || 'ashlands') === realm.slug);
          if (!realmLocs.length) continue;
          const discCount = realmLocs.filter(l => discLocation.has(l.slug)).length;
          html += `<div style="margin-bottom:16px">
            <div class="label" style="margin-bottom:6px">${realm.icon} ${esc(realm.name)} <span class="muted">(${discCount}/${realmLocs.length})</span></div>`;
          // Sort: towns first, then wild, then dungeon
          const sortOrder = { town: 0, wild: 1, dungeon: 2 };
          realmLocs.sort((a, b) => (sortOrder[a.type] || 9) - (sortOrder[b.type] || 9));
          for (const loc of realmLocs) {
            const found = discLocation.has(loc.slug);
            const meta = locMeta[loc.slug] || {};
            if (found) {
              const tags = [];
              if (loc.type === 'town') { if (meta.hasShop) tags.push('🏪'); if (meta.hasInn) tags.push('🏨'); tags.push('🏛'); }
              if (meta.canExplore) tags.push('🌿');
              const dconf = dungeons[loc.slug];
              if (dconf) tags.push('🏰');
              html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;margin-bottom:4px;background:rgba(255,255,255,.02);cursor:pointer" data-action="codexNav" data-slug="locations" data-sub="${loc.slug}">
                <span>${typeIcon(loc.type)}</span>
                <div style="flex:1"><strong style="font-size:.85rem">${esc(loc.name)}</strong> <span class="muted" style="font-size:.72rem">${loc.type}${meta.threatLevel ? ' · Lv' + meta.threatLevel : ''}</span>
                  ${tags.length ? `<div style="font-size:.65rem;margin-top:1px">${tags.join(' ')}</div>` : ''}
                </div>
                <span class="muted">›</span>
              </div>`;
            } else {
              html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;margin-bottom:4px;opacity:.35">
                <span>❓</span><span class="muted">???</span>
              </div>`;
            }
          }
          html += `</div>`;
        }
        return html;
      }

      return html;
    }

    function renderProgressionView() {
      if (!progressionData) return '<div class="muted">Loading...</div>';
      const pd = progressionData;
      const c = state.character;
      let html = '<div class="eyebrow">🏆 PROGRESSION</div>';
      html += `<h2 style="font-family:Cinzel,serif;margin:8px 0 4px">${esc(c.name)} ${c.active_title ? '<span style="font-size:.7em;color:var(--gold)">⟨' + esc(c.active_title) + '⟩</span>' : ''}</h2>`;

      // Daily login
      const login = c.daily_login || {};
      const today = new Date().toISOString().slice(0, 10);
      const canClaim = login.lastDate !== today;
      html += `<div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;padding:8px 12px;border-radius:8px;background:rgba(214,176,95,.06);border:1px solid rgba(214,176,95,.15)">
        <span style="font-size:1.3rem">📅</span>
        <div style="flex:1"><strong>Daily Login</strong> <span class="muted">Streak: ${login.streak || 0} days</span></div>
        ${canClaim ? '<button class="small" data-action="claimDailyLogin">Claim Today</button>' : '<span class="muted" style="font-size:.8rem">✅ Claimed today</span>'}
      </div>`;

      html += `<div class="tab-bar" style="margin-bottom:14px">
        <button class="tab-btn ${progressionTab === 'achievements' ? 'active' : ''}" data-action="setProgressionTab" data-tab="achievements">🏆 Achievements</button>
        <button class="tab-btn ${progressionTab === 'titles' ? 'active' : ''}" data-action="setProgressionTab" data-tab="titles">👑 Titles</button>
        <button class="tab-btn ${progressionTab === 'codex' ? 'active' : ''}" data-action="setProgressionTab" data-tab="codex">📖 Codex</button>
        <button class="tab-btn ${progressionTab === 'weekly' ? 'active' : ''}" data-action="setProgressionTab" data-tab="weekly">📋 Weekly</button>
        <button class="tab-btn ${progressionTab === 'feed' ? 'active' : ''}" data-action="setProgressionTab" data-tab="feed">🌍 World</button>
      </div>`;

      if (progressionTab === 'achievements') {
        const achs = pd.achievements?.achievements || [];
        const unlocked = achs.filter(a => a.unlocked).length;
        html += `<div class="label" style="margin-bottom:8px">ACHIEVEMENTS <span class="muted" style="font-weight:400">${unlocked}/${achs.length}</span></div>`;
        const categories = [...new Set(achs.map(a => a.category))];
        for (const cat of categories) {
          const catAchs = achs.filter(a => a.category === cat);
          const catUnlocked = catAchs.filter(a => a.unlocked).length;
          html += `<div style="margin-bottom:12px"><div style="font-weight:600;font-size:.85rem;margin-bottom:4px">${cat.charAt(0).toUpperCase() + cat.slice(1)} (${catUnlocked}/${catAchs.length})</div>`;
          html += catAchs.map(a => {
            const rewardParts = [];
            if (a.reward?.gold) rewardParts.push(a.reward.gold + 'g');
            if (a.reward?.tokens) rewardParts.push(a.reward.tokens + ' ✦');
            if (a.reward?.title) rewardParts.push('Title: ' + a.reward.title);
            return `<div style="display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:6px;margin-bottom:2px;${a.unlocked ? 'background:rgba(52,211,153,.06)' : 'opacity:.5'}">
              <span style="font-size:1rem;min-width:24px">${a.unlocked ? '✅' : a.icon}</span>
              <div style="flex:1;min-width:0"><strong style="font-size:.82rem">${esc(a.name)}</strong> <span class="muted" style="font-size:.75rem">— ${esc(a.description)}</span></div>
              ${rewardParts.length ? '<span class="muted" style="font-size:.7rem;white-space:nowrap">' + rewardParts.join(', ') + '</span>' : ''}
            </div>`;
          }).join('');
          html += `</div>`;
        }
      }

      if (progressionTab === 'titles') {
        const achs = pd.achievements?.achievements || [];
        const earnedTitles = achs.filter(a => a.unlocked && a.reward?.title).map(a => a.reward.title);
        html += `<div class="label" style="margin-bottom:8px">EARNED TITLES <span class="muted" style="font-weight:400">(${earnedTitles.length})</span></div>`;
        if (earnedTitles.length === 0) {
          html += '<div class="muted" style="font-style:italic">No titles earned yet. Complete achievements to unlock titles.</div>';
        } else {
          html += `<div style="margin-bottom:8px"><button class="secondary small" data-action="setTitle" data-slug="">Clear Title</button></div>`;
          html += earnedTitles.map(t => {
            const isActive = c.active_title === t;
            return `<button class="${isActive ? '' : 'secondary'} small" style="margin:2px 4px" data-action="setTitle" data-slug="${esc(t)}">${isActive ? '👑 ' : ''}${esc(t)}</button>`;
          }).join('');
        }
      }

      if (progressionTab === 'codex') {
        const codex = pd.codex?.codex || {};
        const categories = Object.keys(codex);
        if (categories.length === 0) {
          html += '<div class="muted" style="font-style:italic">Your codex is empty. Explore, fight, and discover!</div>';
        }
        for (const cat of categories) {
          const entries = codex[cat];
          const catLabel = { enemy: '⚔ Enemies', boss: '🔥 Bosses', item: '📦 Items', mythic: '🔴 Mythics', quest: '📜 Quests', dungeon: '🏰 Dungeons', location: '📍 Locations', death: '💀 Deaths' }[cat] || cat;
          html += `<div style="margin-bottom:12px"><div class="label" style="margin-bottom:4px">${catLabel} (${entries.length})</div>`;
          html += `<div style="display:flex;flex-wrap:wrap;gap:4px">`;
          html += entries.map(e => `<span style="font-size:.78rem;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid var(--line)">${esc(e.name)} <span class="muted">×${e.count}</span></span>`).join('');
          html += `</div></div>`;
        }
      }

      if (progressionTab === 'weekly') {
        const quests = pd.weekly?.weeklyQuests || [];
        html += `<div class="label" style="margin-bottom:8px">WEEKLY QUESTS <span class="muted" style="font-weight:400">(resets Monday)</span></div>`;
        if (quests.length === 0) {
          html += '<div class="muted" style="font-style:italic">No weekly quests available.</div>';
        }
        for (const wq of quests) {
          const pct = wq.killTarget > 0 ? Math.min(100, wq.kills / wq.killTarget * 100) : 0;
          html += `<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:8px;background:rgba(255,255,255,.02)">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong>${esc(wq.description)}</strong>
              ${wq.claimed ? '<span style="color:var(--emerald)">✅ Claimed</span>' : wq.completed ? '<button class="small" data-action="claimWeeklyQuest" data-slug="' + wq.slug + '">Claim</button>' : ''}
            </div>
            <div class="muted" style="font-size:.8rem;margin-top:4px">📍 ${esc(wq.locationName)} · ${wq.kills}/${wq.killTarget} kills · Reward: ${wq.rewardGold}g, ${wq.rewardXp} XP, ${wq.rewardTokens} ✦</div>
            <div class="bar" style="margin-top:4px"><div class="fill hp" style="width:${pct}%;${wq.completed ? 'background:var(--emerald)' : ''}"></div></div>
          </div>`;
        }
      }

      if (progressionTab === 'feed') {
        const feed = pd.feed?.feed || [];
        html += `<div class="label" style="margin-bottom:8px">WORLD FEED</div>`;
        if (feed.length === 0) {
          html += '<div class="muted" style="font-style:italic">Nothing noteworthy has happened yet...</div>';
        }
        for (const entry of feed) {
          const ago = Math.floor((Date.now() - new Date(entry.created_at).getTime()) / 60000);
          const timeStr = ago < 60 ? ago + 'm ago' : Math.floor(ago / 60) + 'h ago';
          html += `<div style="padding:6px 0;border-bottom:1px solid var(--line);font-size:.85rem">
            ${esc(entry.message)} <span class="muted" style="font-size:.72rem">${timeStr}</span>
          </div>`;
        }
      }

      html += '<div style="margin-top:16px"><button class="secondary" data-action="leaveProgression">← Back</button></div>';
      return html;
    }
    function leaveProgression() { storyView = 'menu'; progressionData = null; renderStoryPanel(); }

    async function classTrainerRespec() {
      const ok = await appConfirm('Are you sure you want to respec? This costs <strong>100 ✦ Arcane Tokens</strong> and removes your current specialization/companion. You can choose again afterwards.', '🔄 Respec', 'Cancel');
      if (!ok) return;
      try {
        const res = await post('/api/fantasy/class-trainer/respec');
        if (!res) return;
        applyState(res);
        if (res.messages) for (const m of res.messages) showMessage(m);
        await enterClassTrainer();
      } catch (err) { showMessage(err.message, true); }
    }
    function leaveArenaStore() { storyView = 'menu'; arenaStoreData = null; lastMessages = []; renderStoryPanel(); }
    async function loadArenaStore() {
      try { const res = await post('/api/fantasy/arena/store'); arenaStoreData = res; renderGame(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function arenaStoreBuy(slotIndex) {
      try {
        const res = await post('/api/fantasy/arena/store/buy', { slotIndex: Number(slotIndex) });
        applyState(res); arenaStoreData.store = res.store; arenaStoreData.arenaPoints = state.character.arena_points;
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function arenaStoreReroll() {
      const cost = arenaStoreData?.prices ? Object.values(arenaStoreData.prices).reduce((s,p) => s + (p.reroll||0), 0) : 0;
      const isFree = arenaStoreData?.freeRerollAvailable;
      if (!isFree) {
        const ok = await appConfirm(`Reroll all arena store items for <strong style="color:#fbbf24">${cost} AP</strong>?`, 'Reroll', 'Cancel');
        if (!ok) return;
      }
      try {
        const res = await post('/api/fantasy/arena/store/reroll');
        applyState(res); arenaStoreData = { ...arenaStoreData, store: res.store, rerollCost: res.rerollCost, freeRerollAvailable: res.freeRerollAvailable, arenaPoints: res.arenaPoints };
        arenaStoreSelected = null; renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    function selectArenaStoreSlot(idx) { arenaStoreSelected = arenaStoreSelected === Number(idx) ? null : Number(idx); renderGame(); }
    async function arenaStoreRerollSlot(slotIndex) {
      const slot = arenaStoreData?.store?.[slotIndex];
      if (!slot) return;
      const cost = arenaStoreData?.prices?.[slot.rarity]?.reroll || 0;
      const ok = await appConfirm(`Reroll <strong class="rarity-${slot.rarity}">${esc(slot.rarity)}</strong> slot for <strong style="color:#fbbf24">${cost} AP</strong>?`, 'Reroll', 'Cancel');
      if (!ok) return;
      try {
        const res = await post('/api/fantasy/arena/store/reroll-slot', { slotIndex: Number(slotIndex) });
        applyState(res);
        arenaStoreData = { ...arenaStoreData, store: res.store, arenaPoints: res.arenaPoints, prices: res.prices };
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    // ═══════════════════════════════════════════════════════════════
    // RAID TOWER — Rendering
    // ═══════════════════════════════════════════════════════════════

    function renderRaidTowerView() {
      if (!raidListData) return '<div class="shop-empty">Loading raids...</div>';
      const raids = raidListData.raids || [];
      const completions = raidListData.completions || {};
      const c = state.character;
      const CLASS_ICONS = { warrior: '⚔', mage: '🔮', rogue: '🗡', cleric: '✝', ranger: '🏹' };

      const diffColors = { easy: '#22c55e', medium: '#f59e0b', hard: '#ef4444' };
      const diffLabels = { easy: 'EASY', medium: 'MEDIUM', hard: 'HARD' };

      let html = `
        <div class="guild-header">
          <div>
            <div class="eyebrow">🕳 THE RAID TOWER</div>
            <h3 style="margin:0">Ashenmaw Spire</h3>
          </div>
        </div>`;

      // Party setup now lives entirely in the side-panel party tab.
      if (!partyData) {
        html += `
          <div style="background:rgba(20,184,166,.06);border:1px solid rgba(20,184,166,.2);border-radius:12px;padding:14px;margin-bottom:16px;text-align:center">
            <div style="font-size:.9rem;margin-bottom:8px">Raids require a party of 2–5.</div>
            <button class="primary-action" data-action="partyCreate" style="width:100%">👥 Create Raid Party</button>
            <div class="muted" style="margin-top:8px;font-size:.78rem">Form your party in the Friends panel — no location needed.</div>
          </div>`;
      } else {
        html += `
          <div style="background:rgba(20,184,166,.06);border:1px solid rgba(20,184,166,.2);border-radius:12px;padding:12px 14px;margin-bottom:16px;text-align:center">
            <div class="eyebrow" style="color:#14b8a6">👥 PARTY OF ${partyData.members.length}</div>
            <div class="muted" style="font-size:.82rem;margin-top:6px">Pick a raid and manage the lobby from the <strong>Party panel</strong> on the right.</div>
          </div>`;
      }

      // Pending party invites (if no party)
      if (partyInvites && partyInvites.length > 0 && !partyData) {
        html += `<div style="background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.15);border-radius:12px;padding:12px;margin-bottom:16px">
          <div class="label" style="color:#fbbf24;margin-bottom:6px">📨 PARTY INVITES</div>`;
        for (const inv of partyInvites) {
          html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0">
            <span>${esc(inv.from_name)} (${CLASS_ICONS[inv.from_class]||''} Lv${inv.from_level})</span>
            <div style="display:flex;gap:4px">
              <button class="green small" data-action="partyAccept" data-id="${inv.invite_id}">Join</button>
              <button class="secondary small" data-action="partyDecline" data-id="${inv.invite_id}">✕</button>
            </div>
          </div>`;
        }
        html += `</div>`;
      }

      // ── RAID LIST (informational only) ──
      html += `<div class="muted" style="margin-bottom:12px">Multi-floor raids with unique enemies, lore, and powerful bosses. Once the party enters, there is no retreat between floors.</div>`;

      for (const raid of raids) {
        const comp = completions[raid.slug];
        const canEnter = raid.canEnter;
        const diffColor = diffColors[raid.difficulty] || '#888';
        const diffLabel = diffLabels[raid.difficulty] || raid.difficulty.toUpperCase();

        html += `
          <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;${!canEnter ? 'opacity:.55;' : ''}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <div style="font-size:1.2rem;font-weight:700">${raid.icon} ${esc(raid.name)}</div>
              <span style="background:${diffColor};color:#000;padding:2px 10px;border-radius:20px;font-size:.72rem;font-weight:800;letter-spacing:.5px">${diffLabel}</span>
            </div>
            <div class="muted" style="margin-bottom:8px;line-height:1.5">${esc(raid.description)}</div>
            <div style="display:flex;gap:16px;font-size:.82rem;flex-wrap:wrap">
              <span>📊 ${raid.floors} Floors</span>
              <span>⚔ Level ${raid.levelReq}+</span>
              ${comp ? `<span style="color:#22c55e">✅ Cleared ${comp.clears}×</span>` : '<span class="muted">Not yet cleared</span>'}
              ${comp?.bestTimeSeconds != null ? `<span style="color:#fbbf24">⏱ Best ${Math.floor(comp.bestTimeSeconds/60)}:${String(comp.bestTimeSeconds%60).padStart(2,'0')}</span>` : ''}
            </div>
            ${!canEnter ? `<div class="muted" style="font-style:italic;margin-top:6px;font-size:.8rem">Requires Level ${raid.levelReq}</div>` : ''}
          </div>`;
      }

      html += `<button class="secondary" data-action="leaveRaidTower" style="margin-top:12px">← Leave Tower</button>`;
      return html;
    }

    function renderRaidState() {
      const c = state.character;
      const rs = partyRaidState;
      if (!rs) return '';

      const isLeader = partyData?.leaderId === c.id;
      const leaderMember = (partyData?.members || []).find(m => m.isLeader);
      const leaderName = leaderMember?.name || 'the leader';
      const waitingBtn = `<div class="primary-action" style="pointer-events:none;opacity:.6;text-align:center;background:linear-gradient(135deg,#3a2f20,#4a3a28);cursor:default;font-style:italic">⏳ Waiting for ${esc(leaderName)} to continue...</div>`;

      const hpPct = Math.round((c.hp / c.max_hp) * 100);
      const mpPct = Math.round((c.mp / c.max_mp) * 100);
      const progressPct = Math.round((rs.floorsCleared / rs.totalFloors) * 100);
      const raidBgUrl = locationImageUrl('raid-' + rs.raidSlug);
      const raidBox = `<div class="combat-box" style="position:relative;overflow:hidden"><div class="combat-bg"><img src="${raidBgUrl}" alt="" onerror="this.parentElement.style.display='none'"></div><div style="position:relative">`;

      // Active buffs/debuffs indicators
      const activeMods = [];
      for (const b of (rs.floorBuffs || [])) { if (b.turnsLeft > 0) activeMods.push(`<span style="color:#22c55e;font-size:.72rem">⬆${b.stat?.toUpperCase()} +${b.amount}</span>`); }
      for (const d of (rs.floorDebuffs || [])) { if (d.turns > 0) activeMods.push(`<span style="color:#ef4444;font-size:.72rem">☠${d.name}</span>`); }
      const modsHtml = activeMods.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${activeMods.join('')}</div>` : '';

      const raidHeader = `
        <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div class="eyebrow">🕳 RAID IN PROGRESS</div>
            <span class="muted" style="font-size:.78rem">Floor ${rs.currentFloor} / ${rs.totalFloors}</span>
          </div>
          <div class="bar" style="margin-bottom:8px"><div class="fill dungeon" style="width:${progressPct}%"></div></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div class="statcard"><div class="label">HP</div><div class="value" style="color:var(--red)">${c.hp}/${c.max_hp}</div><div class="bar thin"><div class="fill hp" style="width:${hpPct}%"></div></div></div>
            <div class="statcard"><div class="label">MP</div><div class="value" style="color:var(--violet)">${c.mp}/${c.max_mp}</div><div class="bar thin"><div class="fill mp" style="width:${mpPct}%"></div></div></div>
          </div>
          ${modsHtml}
        </div>`;

      // ── COMPLETE ──
      if (rs.phase === 'complete') {
        const raidName = rs.raidSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        const partySize = (partyData?.members || []).length || 1;

        // Run time
        let runTimeHtml = '';
        if (rs.startedAt && rs.completedAt) {
          const ms = new Date(rs.completedAt).getTime() - new Date(rs.startedAt).getTime();
          const totalSec = Math.max(0, Math.floor(ms / 1000));
          const mm = Math.floor(totalSec / 60);
          const ss = String(totalSec % 60).padStart(2, '0');
          runTimeHtml = `<div style="font-size:1.8rem;font-weight:800;color:#fbbf24;font-family:'Fira Code',monospace;letter-spacing:.06em">${mm}:${ss}</div>
            <div class="muted" style="font-size:.68rem;letter-spacing:.1em;text-transform:uppercase">Run time</div>`;
        }

        // Personal rewards (for this character)
        const mine = rs.personalRewards?.[c.id] || null;
        const myXp = mine?.xp ?? Math.floor((rs.totalXp || 0) / partySize);
        const myGold = mine?.gold ?? Math.floor((rs.totalGold || 0) / partySize);
        const myTokens = mine?.tokens ?? 0;
        const myLoot = mine?.loot || [];

        const rarityColor = { common:'#aaa', uncommon:'#22c55e', rare:'#3b82f6', epic:'#a855f7', mythic:'#fbbf24', exotic:'#06b6d4' };
        const lootHtml = myLoot.length
          ? myLoot.map(it => {
              const c = rarityColor[it.rarity] || '#ccc';
              const icon = it.source === 'exotic' ? '🔷' : it.rarity === 'mythic' ? '🟡' : '🔴';
              return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,.03);border-left:3px solid ${c};border-radius:4px;margin-bottom:4px">
                <span style="font-size:1rem">${icon}</span>
                <div style="flex:1;min-width:0">
                  <div style="color:${c};font-weight:600;font-size:.86rem">${esc(it.name)}</div>
                  <div class="muted" style="font-size:.7rem;text-transform:capitalize">${esc(it.rarity || 'common')}${it.source === 'exotic' ? ' · class exclusive' : ''}</div>
                </div>
              </div>`;
            }).join('')
          : `<div class="muted" style="text-align:center;font-style:italic;padding:8px;font-size:.85rem">No items dropped this run — the loot tables were quiet.</div>`;

        return raidHeader + raidBox + `
            <div style="text-align:center;margin-bottom:14px">
              <div style="font-size:2.4rem;line-height:1">🏆</div>
              <div class="eyebrow" style="color:#22c55e;font-size:.72rem;margin-top:6px">RAID COMPLETE</div>
              <h2 style="margin:6px 0 0;color:#fbbf24;font-size:1.4rem">${esc(raidName)}</h2>
            </div>

            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0;text-align:center">
              <div style="background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.2);border-radius:8px;padding:10px">
                ${runTimeHtml || `<div style="font-size:1.4rem;font-weight:700;color:#fbbf24">—</div><div class="muted" style="font-size:.68rem;text-transform:uppercase">Run time</div>`}
              </div>
              <div style="background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:8px;padding:10px">
                <div style="font-size:1.4rem;font-weight:700;color:#22c55e">${rs.floorsCleared}/${rs.totalFloors}</div>
                <div class="muted" style="font-size:.68rem;text-transform:uppercase">Floors Cleared</div>
              </div>
              <div style="background:rgba(139,92,246,.06);border:1px solid rgba(139,92,246,.2);border-radius:8px;padding:10px">
                <div style="font-size:1.4rem;font-weight:700;color:#a78bfa">${partySize}</div>
                <div class="muted" style="font-size:.68rem;text-transform:uppercase">Party Size</div>
              </div>
            </div>

            ${rs.completionLore ? `<div style="line-height:1.7;margin:14px 0;white-space:pre-line;font-size:.92rem;color:#ccc;padding:12px;background:rgba(255,255,255,.02);border-left:3px solid #fbbf24;border-radius:4px;font-style:italic">${esc(rs.completionLore)}</div>` : ''}

            <div style="margin:16px 0 10px">
              <div class="label" style="margin-bottom:8px;color:#fbbf24">YOUR HAUL</div>
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
                <div style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:8px;text-align:center">
                  <div style="font-size:1.1rem;font-weight:700;color:#fbbf24">💰 ${myGold}</div>
                  <div class="muted" style="font-size:.66rem;text-transform:uppercase">Gold</div>
                </div>
                <div style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:8px;text-align:center">
                  <div style="font-size:1.1rem;font-weight:700;color:#22c55e">⭐ ${myXp}</div>
                  <div class="muted" style="font-size:.66rem;text-transform:uppercase">Experience</div>
                </div>
                <div style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:8px;text-align:center">
                  <div style="font-size:1.1rem;font-weight:700;color:#a78bfa">✦ ${myTokens}</div>
                  <div class="muted" style="font-size:.66rem;text-transform:uppercase">Tokens</div>
                </div>
              </div>
              <div class="label" style="margin-bottom:6px">LOOT (${myLoot.length})</div>
              <div>${lootHtml}</div>
            </div>

            <button class="primary-action" data-action="partyRaidDismiss" style="margin-top:16px;width:100%;background:linear-gradient(135deg,#0d9488,#14b8a6);padding:10px;font-size:1rem">✓ Finish Raid</button>
            <div class="muted" style="text-align:center;margin-top:6px;font-size:.72rem;font-style:italic">Takes you back to wherever you were. Others can stay on this screen as long as they like.</div>
          </div></div>`;
      }

      // ── LORE ──
      if (rs.phase === 'lore') {
        const loreText = getRaidFloorLore(rs);
        return raidHeader + raidBox + `
            <div class="eyebrow">📜 FLOOR ${rs.currentFloor} — ${esc(getRaidFloorName(rs))}</div>
            <div style="line-height:1.7;margin:14px 0;white-space:pre-line;font-size:.92rem;color:#ccc">${esc(loreText)}</div>
            ${isLeader ? `<button class="primary-action" data-action="partyRaidAdvance">⚔ Continue Deeper</button>` : waitingBtn}
          </div></div>`;
      }

      // ── ENCOUNTER ──
      if (rs.phase === 'encounter') {
        return raidHeader + raidBox + `
            <div class="eyebrow">🕳 FLOOR ${rs.currentFloor}</div>
            <div style="margin:12px 0;color:#ccc">Something stirs in the darkness ahead...</div>
            ${isLeader ? `<button class="primary-action" data-action="partyRaidAdvance">⚔ Advance</button>` : waitingBtn}
            <button class="secondary" data-action="leaveRaid" style="margin-top:8px">🚪 Abandon Raid</button>
          </div></div>`;
      }

      // ── CHOICE ──
      if (rs.phase === 'choice') {
        const choiceData = getRaidCurrentChoice(rs);
        if (choiceData) {
          const votes = rs.votes || {};
          const myVote = votes[c.id];
          const haveVoted = myVote !== undefined;
          const members = partyData?.members || [];
          const totalMembers = members.length;
          const votedCount = Object.keys(votes).length;

          // Build voter name list per choice
          const votersByChoice = {};
          for (const [charIdStr, choiceIdx] of Object.entries(votes)) {
            const voterId = Number(charIdStr);
            const voter = members.find(m => m.charId === voterId);
            const name = voter?.name || '?';
            if (!votersByChoice[choiceIdx]) votersByChoice[choiceIdx] = [];
            votersByChoice[choiceIdx].push(name);
          }

          let choicesHtml = '';
          (choiceData.choices || []).forEach((ch, idx) => {
            const voters = votersByChoice[idx] || [];
            const isMyChoice = myVote === idx;
            const voterBadges = voters.map(n => `<span style="background:rgba(34,197,94,.15);border:1px solid #22c55e;color:#22c55e;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:600;white-space:nowrap">✓ ${esc(n)}</span>`).join('');
            const selectedStyle = isMyChoice ? 'background:rgba(34,197,94,.12);border:2px solid #22c55e;' : '';
            const lockedStyle = haveVoted && !isMyChoice ? 'opacity:.55;' : '';
            const interactiveAttr = haveVoted ? 'style="text-align:left;padding:12px 16px;pointer-events:none;' + selectedStyle + lockedStyle + '"' : `style="text-align:left;padding:12px 16px;${selectedStyle}"`;
            choicesHtml += `
              <button class="arena-choice-card" data-action="partyRaidChoice" data-value="${idx}" ${interactiveAttr}>
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                  <div style="font-weight:700;flex:1;min-width:180px">${isMyChoice ? '✓ ' : ''}${esc(ch.label)}</div>
                  ${voterBadges ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${voterBadges}</div>` : ''}
                </div>
              </button>`;
          });

          const statusLine = haveVoted
            ? `<div style="text-align:center;margin-top:10px;color:#22c55e;font-size:.88rem;font-weight:600">✓ Locked in — waiting for party (${votedCount}/${totalMembers} voted)</div>`
            : `<div style="text-align:center;margin-top:10px;color:var(--muted);font-size:.82rem">${votedCount}/${totalMembers} voted</div>`;

          return raidHeader + raidBox + `
              <div class="eyebrow">📜 ${esc(choiceData.title || 'A Choice')}</div>
              <div style="line-height:1.7;margin:14px 0;white-space:pre-line;font-size:.92rem;color:#ccc">${esc(choiceData.text)}</div>
              <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">${choicesHtml}</div>
              ${statusLine}
            </div></div>`;
        }
        return raidHeader + raidBox + `<div style="text-align:center;padding:16px;color:var(--muted);font-style:italic">Loading raid data...</div></div></div>`;
      }

      // ── CHOICE RESULT (shows what happened) ──
      if (rs.phase === 'choiceResult' && rs.lastChoiceOutcome) {
        const o = rs.lastChoiceOutcome;
        const resultColor = o.success ? '#22c55e' : '#ef4444';
        const resultIcon = o.success ? '✅' : '❌';
        const rollHtml = o.rollInfo ? `
          <div style="background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:8px;padding:10px;margin:12px 0;font-family:'Fira Code',monospace;font-size:.82rem">
            🎲 <strong>${o.rollInfo.stat.toUpperCase()}</strong> check: rolled <strong>${o.rollInfo.roll}</strong> + ${o.rollInfo.modifier} modifier = <strong style="color:${resultColor}">${o.rollInfo.total}</strong> vs DC ${o.rollInfo.dc} — <strong style="color:${resultColor}">${o.success ? 'SUCCESS' : 'FAILED'}</strong>
          </div>` : '';
        const effectsHtml = (o.messages || []).map(m => {
          const cls = m.includes('⬆') || m.includes('Healed') || m.includes('Restored') || m.includes('⭐') ? 'color:#22c55e' : m.includes('💔') || m.includes('☠') || m.includes('Lost') ? 'color:#ef4444' : 'color:#ccc';
          return `<div style="${cls};font-size:.88rem;padding:2px 0">${esc(m)}</div>`;
        }).join('');

        // Vote breakdown — shows what each player picked and which option won
        let voteBreakdownHtml = '';
        if (o.choiceLabels && o.voteCounts) {
          const members = partyData?.members || [];
          const rows = o.choiceLabels.map((label, idx) => {
            const count = o.voteCounts[idx] || 0;
            const voterIds = (o.voters && o.voters[idx]) || [];
            const voterNames = voterIds
              .map(cid => members.find(m => m.charId === cid)?.name || '?')
              .map(esc)
              .join(', ');
            const isWinner = idx === o.winningIdx;
            const rowStyle = isWinner
              ? 'border-left:3px solid #22c55e;background:rgba(34,197,94,.08)'
              : 'border-left:3px solid transparent';
            return `
              <div style="padding:6px 10px;margin:4px 0;border-radius:4px;${rowStyle}">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                  <div style="font-weight:${isWinner ? '700' : '500'};${isWinner ? 'color:#22c55e' : 'color:#ccc'}">${isWinner ? '★ ' : ''}${esc(label)}</div>
                  <div style="font-size:.78rem;color:var(--muted)">${count} vote${count === 1 ? '' : 's'}</div>
                </div>
                ${voterNames ? `<div style="font-size:.72rem;color:#9ca3af;margin-top:2px">${voterNames}</div>` : ''}
              </div>`;
          }).join('');
          voteBreakdownHtml = `
            <div style="margin:12px 0;padding:10px;background:rgba(255,255,255,.04);border-radius:8px">
              <div class="label" style="margin-bottom:4px">🗳 PARTY CHOSE</div>
              ${rows}
            </div>`;
        }

        return raidHeader + raidBox + `
            <div class="eyebrow" style="color:${resultColor}">${resultIcon} ${esc(o.title || 'Outcome')}</div>
            ${voteBreakdownHtml}
            <div style="line-height:1.7;margin:14px 0;white-space:pre-line;font-size:.92rem;color:#ccc">${esc(o.text)}</div>
            ${rollHtml}
            ${effectsHtml ? `<div style="margin:12px 0;padding:10px;background:rgba(255,255,255,.03);border-radius:8px">${effectsHtml}</div>` : ''}
            ${isLeader ? `<button class="primary-action" data-action="partyRaidAdvance" style="margin-top:8px">⚔ Continue</button>` : waitingBtn}
          </div></div>`;
      }

      // ── PRE-BOSS RECOVERY ──
      if (rs.phase === 'preBoss') {
        const choiceMade = rs.preBossChoiceMade?.[c.id];
        const bossInfo = getRaidFloorBoss(rs);
        return raidHeader + raidBox + `
            <div class="eyebrow" style="color:#ef4444">🔥 BOSS AHEAD — FLOOR ${rs.currentFloor}</div>
            ${bossInfo ? `<div style="margin:8px 0;font-size:1.1rem;font-weight:700;color:#fbbf24">${esc(bossInfo.name)}</div>
            <div style="line-height:1.6;margin:8px 0;font-size:.88rem;color:#999;font-style:italic">${esc(bossInfo.description || '')}</div>` : ''}
            <div style="margin:12px 0;color:#ccc;font-size:.9rem">A moment of respite before the final confrontation on this floor. Choose wisely — this is your last chance to recover.</div>
            ${!choiceMade ? `
              <div class="label" style="margin:12px 0 8px">PREPARE YOURSELF</div>
              <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
                <button class="arena-choice-card" data-action="partyRaidFloorChoice" data-value="healHp">
                  <span class="arena-choice-icon">🩸</span>
                  <div><div style="font-weight:700">Restore 25% HP</div><div class="muted" style="font-size:.85rem">Heal ${Math.floor(c.max_hp * 0.25)} hit points</div></div>
                </button>
                <button class="arena-choice-card" data-action="partyRaidFloorChoice" data-value="restoreMp">
                  <span class="arena-choice-icon">💜</span>
                  <div><div style="font-weight:700">Restore 25% MP</div><div class="muted" style="font-size:.85rem">Recover ${Math.floor(c.max_mp * 0.25)} mana</div></div>
                </button>
                <button class="arena-choice-card" data-action="partyRaidFloorChoice" data-value="both">
                  <span class="arena-choice-icon">✨</span>
                  <div><div style="font-weight:700">Restore 15% HP + 15% MP</div><div class="muted" style="font-size:.85rem">Balanced recovery</div></div>
                </button>
              </div>
            ` : `
              <div style="text-align:center;padding:8px;margin-bottom:14px;color:var(--muted);font-size:.88rem">Prepared. Ready to fight.</div>
            `}
            ${isLeader
              ? `<button class="primary-action" data-action="partyRaidAdvance" style="background:linear-gradient(135deg,#b91c1c,#dc2626)" ${!choiceMade ? 'disabled' : ''}>⚔ Face the Boss</button>`
              : waitingBtn}
            <button class="secondary" data-action="leaveRaid" style="margin-top:8px">🚪 Abandon Raid</button>
          </div></div>`;
      }

      // ── NEXT FLOOR (no transition — straight to next) ──
      if (rs.phase === 'nextFloor') {
        return raidHeader + raidBox + `
            <div class="eyebrow" style="color:#22c55e">✅ FLOOR ${rs.currentFloor} CLEARED</div>
            <div style="margin:12px 0;color:#ccc">The way deeper opens before you. There is no turning back.</div>
            ${isLeader ? `<button class="primary-action" data-action="partyRaidAdvance">⚔ Descend to Floor ${rs.currentFloor + 1}</button>` : waitingBtn}
          </div></div>`;
      }

      return raidHeader + '<div class="muted">Unknown raid state.</div>';
    }

    // Helpers to extract raid content data for display
    // These read from raidListData cache or return defaults
    let raidContentCache = null;
    async function ensureRaidContent(slug) {
      if (raidContentCache && raidContentCache.slug === slug) return raidContentCache;
      try {
        const resp = await fetch('/api/fantasy/raid/content?slug=' + slug, { credentials: 'include' });
        if (resp.ok) { raidContentCache = await resp.json(); return raidContentCache; }
      } catch(e) {}
      return null;
    }

    function getRaidFloorLore(rs) {
      // Try to get from the raid JSON that was loaded — we'll cache it
      if (raidContentCache && raidContentCache.slug === rs.raidSlug) {
        const floor = raidContentCache.floors?.[rs.currentFloor - 1];
        return floor?.lore || 'The darkness beckons...';
      }
      // Trigger async load for next render
      loadRaidContent(rs.raidSlug);
      return 'Loading...';
    }
    function getRaidFloorName(rs) {
      if (raidContentCache && raidContentCache.slug === rs.raidSlug) {
        const floor = raidContentCache.floors?.[rs.currentFloor - 1];
        return floor?.name || `Floor ${rs.currentFloor}`;
      }
      return `Floor ${rs.currentFloor}`;
    }
    function getRaidFloorBoss(rs) {
      if (raidContentCache && raidContentCache.slug === rs.raidSlug) {
        const floor = raidContentCache.floors?.[rs.currentFloor - 1];
        return floor?.boss || null;
      }
      return null;
    }
    function getRaidCurrentChoice(rs) {
      if (raidContentCache && raidContentCache.slug === rs.raidSlug) {
        const floor = raidContentCache.floors?.[rs.currentFloor - 1];
        const encounter = floor?.encounters?.[rs.encounterIndex];
        if (encounter?.type === 'choice') return encounter;
      }
      // Trigger async load if cache is missing
      loadRaidContent(rs.raidSlug);
      return null;
    }
    async function loadRaidContent(slug) {
      if (raidContentCache && raidContentCache.slug === slug) return;
      try {
        const resp = await fetch('/api/fantasy/raid/content?slug=' + encodeURIComponent(slug), { credentials: 'include' });
        if (resp.ok) { raidContentCache = await resp.json(); raidContentCache.slug = slug; renderGame(); }
      } catch(e) {}
    }

    function renderArenaBetweenWaves() {
      const c = state.character;
      const as = state.arenaState;
      if (!as) return '';
      const hpPct = Math.round((c.hp / c.max_hp) * 100);
      const mpPct = Math.round((c.mp / c.max_mp) * 100);
      const choiceMade = as.choiceMade;
      return `
        <div class="arena-box">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div class="eyebrow">🏟 THE ARENA</div>
            <div class="arena-ap-ticker">🏟 ${as.ap || 0} AP earned</div>
          </div>
          <div class="arena-wave-badge" style="margin-bottom:14px">Wave ${as.wave} cleared${as.lastWaveAp ? ' · +' + as.lastWaveAp + ' AP' : ''}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
            <div class="statcard"><div class="label">HP</div><div class="value" style="color:var(--red)">${c.hp} / ${c.max_hp}</div><div class="bar thin"><div class="fill hp" style="width:${hpPct}%"></div></div></div>
            <div class="statcard"><div class="label">MP</div><div class="value" style="color:var(--violet)">${c.mp} / ${c.max_mp}</div><div class="bar thin"><div class="fill mp" style="width:${mpPct}%"></div></div></div>
          </div>
          ${!choiceMade ? `
            <div class="label" style="margin-bottom:8px">CHOOSE YOUR REWARD</div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
              <button class="arena-choice-card" data-action="arenaChoice" data-value="healHp">
                <span class="arena-choice-icon">🩸</span>
                <div><div style="font-weight:700">Restore 30% HP</div><div class="muted" style="font-size:.85rem">Heal ${Math.floor(c.max_hp * 0.3)} hit points</div></div>
              </button>
              <button class="arena-choice-card" data-action="arenaChoice" data-value="restoreMp">
                <span class="arena-choice-icon">💜</span>
                <div><div style="font-weight:700">Restore 30% MP</div><div class="muted" style="font-size:.85rem">Recover ${Math.floor(c.max_mp * 0.3)} mana</div></div>
              </button>
              <button class="arena-choice-card" data-action="arenaChoice" data-value="apBonus">
                <span class="arena-choice-icon">⭐</span>
                <div><div style="font-weight:700;color:#fbbf24">+50% AP Bonus</div><div class="muted" style="font-size:.85rem">Next wave awards 50% more Arena Points — but no recovery</div></div>
              </button>
            </div>
          ` : `
            <div style="text-align:center;padding:8px;margin-bottom:14px;color:var(--muted);font-size:.88rem">
              ${as.apBonusActive ? '⭐ AP bonus active for next wave!' : 'Choice made. Ready for the next wave.'}
            </div>
          `}
          <div class="actions" style="justify-content:center;gap:12px">
            <button class="primary-action" data-action="arenaNextWave" ${!choiceMade ? 'disabled' : ''}>⚔ Wave ${(as.wave || 0) + 1}</button>
            <button class="secondary" data-action="leaveArena">🚪 Leave Arena</button>
          </div>
        </div>`;
    }

    function renderArenaStore() {
      const c = state.character;
      if (!arenaStoreData) { loadArenaStore(); return '<div class="shop-empty">Loading store...</div>'; }
      const store = arenaStoreData.store || [];
      const ap = c.arena_points || 0;
      const sel = arenaStoreSelected != null ? store[arenaStoreSelected] : null;
      const myPrimary = CLASS_PRIMARY_STAT[c.class] || 'str';

      let html = `
        <div class="guild-header">
          <div>
            <div class="eyebrow">🏟 ARENA STORE</div>
            <h3 style="margin:0">Exclusive Gear</h3>
          </div>
          <div style="text-align:right">
            <div class="arena-wave-badge">🏟 ${ap} AP</div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <button class="${arenaStoreData.freeRerollAvailable ? 'green' : 'secondary'}" data-action="arenaStoreReroll">
            ${arenaStoreData.freeRerollAvailable ? '🎲 Free Reroll Available!' : '🎲 Reroll All (' + (arenaStoreData.prices ? Object.values(arenaStoreData.prices).reduce((s,p) => s + (p.reroll||0), 0) : 0) + ' AP)'}
          </button>
        </div>`;

      html += `<div class="ah-panels">`;
      // Left: slot list
      html += `<div class="ah-item-list">`;
      store.forEach((slot, idx) => {
        if (!slot) {
          html += `<div class="ah-list-item" style="opacity:.3;cursor:default"><span class="ali-slot">—</span><span class="ali-name muted">Sold</span><span class="ali-price">—</span></div>`;
          return;
        }
        const isSel = arenaStoreSelected === idx;
        html += `<div class="ah-list-item${isSel ? ' selected' : ''}" data-action="selectArenaStoreSlot" data-id="${idx}" data-num-id="1">
          <span class="ali-slot">${esc(slot.type || '')}</span>
          <span class="ali-name rarity-${slot.rarity}">${esc(slot.name)}</span>
          <span class="ali-price" style="color:#fbbf24">${slot.cost} AP</span>
        </div>`;
      });
      html += `</div>`;

      // Right: detail
      html += `<div class="ah-detail">`;
      if (sel) {
        const prices = arenaStoreData.prices || {};
        const slotRerollCost = prices[sel.rarity]?.reroll || 0;
        html += `
          <div class="eyebrow" style="margin-bottom:4px">${esc(sel.type||'').toUpperCase()}</div>
          <h3 style="margin:0 0 4px"><span class="rarity-${sel.rarity}">${esc(sel.name)}</span></h3>
          <div class="mono muted" style="font-size:.76rem">${sel.rarity}</div>
          ${sel.description ? '<div class="muted" style="font-size:.85rem;margin-top:6px">' + esc(sel.description) + '</div>' : ''}
          ${renderStatSummary(sel.stats || {}, { myPrimary })}
          ${renderPerks(sel.perks)}
          <div style="margin-top:14px;font-size:1.1rem;color:#fbbf24;font-weight:700">🏟 ${sel.cost} AP</div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button data-action="arenaStoreBuy" data-id="${arenaStoreSelected}" data-num-id="1" ${ap < sel.cost ? 'disabled' : ''} style="flex:1">${ap < sel.cost ? 'Not enough AP' : 'Buy for ' + sel.cost + ' AP'}</button>
            <button class="secondary" data-action="arenaStoreRerollSlot" data-id="${arenaStoreSelected}" data-num-id="1" ${ap < slotRerollCost ? 'disabled' : ''} style="flex-shrink:0">🎲 ${slotRerollCost} AP</button>
          </div>`;
      } else {
        html += `<div class="ah-detail-empty">Select an item to view details</div>`;
      }
      html += `</div></div>`;

      html += `<div style="margin-top:18px;text-align:center">
        <button class="secondary" data-action="leaveArenaStore">← Leave Store</button>
      </div>`;
      return html;
    }

    async function loadAhBrowse() {
      try {
        const serverSlotFilter = ahSlotFilter === 'my-class' ? 'all' : ahSlotFilter;
        const res = await post('/api/fantasy/auction/browse', { slotFilter: serverSlotFilter, rarityFilter: ahRarityFilter, sort: ahSort, page: ahPage });
        ahListings = res.listings || [];
        ahPriceHistory = res.priceHistory || {};
        ahTotalPages = res.totalPages || 1;
        renderGame();
      } catch (err) { ahListings = []; showMessage(err.message, true); }
    }

    async function loadAhMyListings() {
      try {
        const res = await post('/api/fantasy/auction/my-listings');
        ahMyListings = res.listings || [];
        renderGame();
      } catch (err) { ahMyListings = []; showMessage(err.message, true); }
    }

    async function ahBuy(listingId) {
      if (!await appConfirm('Confirm this purchase?', 'Buy', 'Cancel')) return;
      try {
        const res = await post('/api/fantasy/auction/buy', { listingId });
        applyState(res);
        ahListings = null; // reload
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    async function ahCancel(listingId) {
      if (!await appConfirm('Cancel this listing? The item will be returned to your inventory.', 'Cancel Listing', 'Keep Listed')) return;
      try {
        const res = await post('/api/fantasy/auction/cancel', { listingId });
        applyState(res);
        ahMyListings = null;
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    function ahSelectSellItem(slug, invId, qty, name, rarity, vendorPrice) {
      ahSellItem = { slug, inventoryId: invId, quantity: qty, name, rarity, vendorPrice };
      ahSellPrice = String(Math.max(1, Math.floor(vendorPrice * 3))); // suggest 3x vendor as starting price
      renderGame();
      setTimeout(() => { const el = document.getElementById('ahPriceInput'); if (el) el.focus(); }, 50);
    }

    async function ahListItem() {
      if (!ahSellItem || !ahSellPrice) return;
      const price = parseInt(ahSellPrice);
      if (!price || price < 1) return showMessage('Set a valid price.', true);
      try {
        const res = await post('/api/fantasy/auction/list', {
          itemSlug: ahSellItem.slug,
          inventoryId: ahSellItem.inventoryId,
          price,
          quantity: 1, // one at a time for now
        });
        applyState(res);
        ahSellItem = null;
        ahSellPrice = '';
        ahTab = 'my';
        ahMyListings = null;
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }

    function leaveMarket() { storyView = 'menu'; lastMessages = []; renderGame(); }
    function enterHome() { storyView = 'home'; homeTab = 'crafting'; homeInvSelected = null; renderStoryPanel(); }
    function selectHomeInvItem(id) { homeInvSelected = homeInvSelected === id ? null : id; renderStoryPanel(); }
    async function storeAllMaterials() {
      const mats = state.inventory.filter(i => i.type === 'material' || i.type === 'gem' || i.type === 'crystal');
      if (!mats.length) { showMessage('No materials to store.'); return; }
      const ok = await appConfirm(`Store all <strong>${mats.reduce((s, i) => s + (i.quantity||1), 0)}</strong> materials, gems & crystals in the stash?`, '📦 Store All', 'Cancel');
      if (!ok) return;
      let stored = 0;
      for (const item of mats) {
        try {
          const res = await post('/api/fantasy/home/store', { itemSlug: item.slug, quantity: item.quantity });
          if (res) { applyState(res); stored++; }
        } catch (err) { /* skip if stash full */ }
      }
      renderGame();
      showMessage(`Stored ${stored} material stack${stored !== 1 ? 's' : ''} in stash.`);
    }
    function goToHomeBase() {
      if (state?.hasCharacter) {
        enterHome();
        return;
      }
      window.location.href = '/';
    }
    function leaveHome() { storyView = 'menu'; lastMessages = []; renderStoryPanel(); }
    function setHomeTab(tab) { homeTab = tab; if (tab === 'forge') { forgeSelectedSlot = null; forgeTab = 'socket'; } renderStoryPanel(); }
    function selectForgeSlot(slot) { forgeSelectedSlot = forgeSelectedSlot === slot ? null : slot; renderStoryPanel(); }
    function setForgeTab(tab) { forgeTab = tab; renderStoryPanel(); }

    async function forgeSocket(equipSlot, socketIndex, gemSlug) {
      try { const res = await post('/api/fantasy/forge/socket', { equipSlot, socketIndex: Number(socketIndex), gemSlug }); applyState(res); renderStoryPanel(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function forgeExtractGem(equipSlot, socketIndex) {
      const ok = await appConfirm('Extract this gem? It costs gold.');
      if (!ok) return;
      try { const res = await post('/api/fantasy/forge/extract-gem', { equipSlot, socketIndex: Number(socketIndex) }); applyState(res); renderStoryPanel(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function forgeEnchant(equipSlot) {
      const ok = await appConfirm('Enchant this item? This will roll new perks (replaces existing). Materials and gold will be consumed.');
      if (!ok) return;
      try { const res = await post('/api/fantasy/forge/enchant', { equipSlot }); applyState(res); renderStoryPanel(); }
      catch (err) { showMessage(err.message, true); }
    }
    async function forgeExtractPerks(equipSlot) {
      const ok = await appConfirm('Extract perks into a Perk Crystal? <strong>75% success rate</strong> — 25% chance perks are destroyed! Gold will be consumed.');
      if (!ok) return;
      try {
        const res = await post('/api/fantasy/forge/extract-perks', { equipSlot });
        applyState(res);
        if (res.success) showMessage('Perk crystal created!');
        else showMessage('Extraction failed! Perks destroyed.', true);
        renderStoryPanel();
      } catch (err) { showMessage(err.message, true); }
    }
    async function forgeApplyCrystal(equipSlot, crystalInventoryId) {
      const ok = await appConfirm('Apply this perk crystal? It will replace any existing perks on the item.');
      if (!ok) return;
      try { const res = await post('/api/fantasy/forge/apply-crystal', { equipSlot, crystalInventoryId: Number(crystalInventoryId) }); applyState(res); renderStoryPanel(); }
      catch (err) { showMessage(err.message, true); }
    }

    function renderForgeView() {
      const c = state.character;
      const myPrimary = CLASS_PRIMARY_STAT[c.class] || 'str';
      // Only show rare+ equipped items
      const forgeableSlots = EQUIP_SLOTS.filter(slot => {
        const eq = state.equipment[slot];
        return eq && ['rare','epic','legendary','mythic'].includes(eq.rarity);
      });
      const gems = state.inventory.filter(i => i.type === 'gem');
      const crystals = state.inventory.filter(i => i.slug === 'perk-crystal');

      if (!forgeSelectedSlot && forgeableSlots.length) forgeSelectedSlot = forgeableSlots[0];
      const sel = forgeSelectedSlot ? state.equipment[forgeSelectedSlot] : null;

      let html = `<div class="eyebrow">⚒ THE FORGE</div>
        <div class="shop-tabs" style="margin-bottom:12px">
          <button class="shop-tab${forgeTab==='socket'?' active':''}" data-action="setForgeTab" data-tab="socket">💎 Sockets</button>
          <button class="shop-tab${forgeTab==='enchant'?' active':''}" data-action="setForgeTab" data-tab="enchant">✨ Enchant</button>
        </div>`;

      if (!forgeableSlots.length) {
        return html + '<div class="shop-empty">No rare+ equipment to work with. Equip rare or better gear first.</div>';
      }

      html += `<div class="ah-panels">`;
      // Left: equipment list
      html += `<div class="ah-item-list">`;
      html += forgeableSlots.map(slot => {
        const eq = state.equipment[slot];
        const isSel = slot === forgeSelectedSlot;
        const socketCount = eq.sockets ? eq.sockets.filter(s => s).length : 0;
        const maxSockets = eq.maxSockets || 0;
        const perkCount = eq.perks?.length || 0;
        return `<div class="ah-list-item${isSel ? ' selected' : ''}" data-action="selectForgeSlot" data-id="${slot}">
          <span class="ali-slot">${esc(slot)}</span>
          <span class="ali-name rarity-${eq.rarity}">${esc(eq.name)}</span>
          <span style="font-size:.65rem;color:var(--muted)">${maxSockets ? '💎' + socketCount + '/' + maxSockets : ''}${perkCount ? ' ✨' + perkCount : ''}</span>
        </div>`;
      }).join('');
      html += `</div>`;

      // Right: detail
      html += `<div class="ah-detail">`;
      if (sel) {
        html += `
          <div class="eyebrow" style="margin-bottom:4px">${esc(forgeSelectedSlot).toUpperCase()}</div>
          <h3 style="margin:0 0 4px"><span class="rarity-${sel.rarity}">${esc(sel.name)}</span></h3>
          <div class="mono muted" style="font-size:.76rem">${sel.rarity}</div>
          ${renderStatSummary(sel.stats || {}, { myPrimary })}
          ${renderPerks(sel.perks)}`;

        if (forgeTab === 'socket') {
          const maxSockets = sel.maxSockets || 0;
          const sockets = sel.sockets || new Array(maxSockets).fill(null);
          if (maxSockets === 0) {
            html += `<div class="gated-notice" style="margin-top:12px">This item has no socket slots (${sel.rarity} rarity).</div>`;
          } else {
            html += `<div class="label" style="margin-top:14px;margin-bottom:6px">SOCKETS (${sockets.filter(s=>s).length}/${maxSockets})</div>`;
            html += `<div style="display:flex;flex-direction:column;gap:6px">`;
            sockets.forEach((sock, idx) => {
              if (sock) {
                const bonusText = Object.entries(sock.bonus || {}).map(([k,v]) => {
                  const labels = { attackPct:'ATK', defensePct:'DEF', hpRegenPct:'HP Regen', mpRegenPct:'MP Regen', critPct:'Crit', dodgePct:'Dodge' };
                  return `+${v}% ${labels[k] || k}`;
                }).join(', ');
                html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(167,123,255,.2);border-radius:10px;background:rgba(167,123,255,.04)">
                  <span>💎</span>
                  <span style="flex:1;font-size:.88rem"><strong>${esc(sock.name)}</strong> <span class="muted" style="font-size:.78rem">${bonusText}</span></span>
                  <button class="secondary small" data-action="forgeExtractGem" data-slot="${forgeSelectedSlot}" data-idx="${idx}">Extract</button>
                </div>`;
              } else {
                html += `<div style="padding:8px 10px;border:2px dashed var(--line);border-radius:10px;text-align:center">
                  <span class="muted" style="font-size:.82rem">Empty socket</span>
                  ${gems.length ? '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;justify-content:center">' + gems.map(g =>
                    '<button class="secondary small" data-action="forgeSocketGem" data-slot="' + forgeSelectedSlot + '" data-idx="' + idx + '" data-gem="' + g.slug + '" style="font-size:.75rem">💎 ' + esc(g.name) + (g.quantity > 1 ? ' ×' + g.quantity : '') + '</button>'
                  ).join('') + '</div>' : '<div class="muted" style="font-size:.75rem;margin-top:4px">No gems in inventory</div>'}
                </div>`;
              }
            });
            html += `</div>`;
          }
        }

        if (forgeTab === 'enchant') {
          const rarity = sel.rarity;
          const canEnchant = ['rare','epic','legendary','mythic'].includes(rarity);
          const hasPerks = sel.perks?.length > 0;

          if (!canEnchant) {
            html += `<div class="gated-notice" style="margin-top:12px">Only rare+ items can be enchanted.</div>`;
          } else {
            // Show enchant costs with material counts from inventory + storage
            const costs = { rare: { gold: 200, materials: 5, rareMaterials: 0 }, epic: { gold: 500, materials: 10, rareMaterials: 2 }, legendary: { gold: 1500, materials: 20, rareMaterials: 5 }, mythic: { gold: 3000, materials: 30, rareMaterials: 10 } };
            const cost = costs[rarity] || costs.rare;
            const extractCosts = { rare: 300, epic: 800, legendary: 2000, mythic: 5000 };
            const extractCost = extractCosts[rarity] || 300;

            const commonMats = ['iron-ore','wolf-pelt','linen-cloth','leather-scraps','spider-silk','boar-tusk','healing-herb','moonpetal','goblin-ear','bone-dust','serpent-fang','bandit-cloak'];
            const rareMats = ['shadow-ichor','wraith-essence','holy-shard'];
            const allItems = [...(state.inventory || []), ...(state.homeStorage || [])];
            let haveCommon = 0, haveRare = 0;
            for (const it of allItems) {
              if (commonMats.includes(it.slug)) haveCommon += (it.quantity || 0);
              if (rareMats.includes(it.slug)) haveRare += (it.quantity || 0);
            }
            const enoughGold = c.gold >= cost.gold;
            const enoughCommon = haveCommon >= cost.materials;
            const enoughRare = !cost.rareMaterials || haveRare >= cost.rareMaterials;
            const canAfford = enoughGold && enoughCommon && enoughRare;

            html += `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">`;
            html += `<div class="label" style="margin-bottom:8px">ENCHANT</div>
              <div style="font-size:.85rem;color:var(--muted);margin-bottom:8px">Roll new random perks. Replaces existing perks. Uses materials from inventory + home storage.</div>
              <div style="font-size:.82rem;margin-bottom:4px">
                Gold: <strong style="color:${enoughGold ? 'var(--gold)' : 'var(--red)'}">${c.gold}g</strong> / ${cost.gold}g
              </div>
              <div style="font-size:.82rem;margin-bottom:4px">
                Common mats: <strong style="color:${enoughCommon ? 'var(--emerald)' : 'var(--red)'}">${haveCommon}</strong> / ${cost.materials}
              </div>
              ${cost.rareMaterials ? '<div style="font-size:.82rem;margin-bottom:4px">Rare mats: <strong style="color:' + (enoughRare ? 'var(--emerald)' : 'var(--red)') + '">' + haveRare + '</strong> / ' + cost.rareMaterials + '</div>' : ''}
              <button class="violet" data-action="forgeEnchant" data-slot="${forgeSelectedSlot}" ${canAfford ? '' : 'disabled'} style="width:100%">✨ Enchant (${cost.gold}g)</button>`;

            if (hasPerks) {
              html += `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
                <div class="label" style="margin-bottom:8px">EXTRACT PERKS</div>
                <div style="font-size:.85rem;color:var(--muted);margin-bottom:4px">Remove perks and create a Perk Crystal. <strong style="color:var(--red)">75% success rate.</strong></div>
                <div style="font-size:.82rem;margin-bottom:10px">Cost: <strong style="color:var(--gold)">${extractCost}g</strong></div>
                <button class="secondary" data-action="forgeExtractPerks" data-slot="${forgeSelectedSlot}" style="width:100%">🔮 Extract Perks (${extractCost}g)</button>
              </div>`;
            }

            // Apply crystal section
            if (crystals.length) {
              html += `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
                <div class="label" style="margin-bottom:8px">APPLY PERK CRYSTAL</div>
                <div style="font-size:.85rem;color:var(--muted);margin-bottom:8px">Apply saved perks from a crystal to this item.</div>
                ${crystals.map(cr => {
                  const crPerks = cr.perks || [];
                  const perkDesc = crPerks.map(p => {
                    if (p.type === 'stat') return '+' + p.value + ' ' + (p.stat||'').toUpperCase();
                    if (p.type === 'lifesteal') return p.value + '% Lifesteal';
                    if (p.type === 'critBonus') return '+' + p.value + '% Crit';
                    if (p.type === 'dodgeBonus') return '+' + p.value + '% Dodge';
                    if (p.type === 'hpRegen') return '+' + p.value + ' HP/turn';
                    if (p.type === 'manaRegen') return '+' + p.value + ' MP/turn';
                    if (p.type === 'onHitStatus') return p.slug + ' on hit';
                    return p.type;
                  }).join(', ');
                  return '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;margin-bottom:4px">' +
                    '<span style="flex:1;font-size:.82rem">🔮 ' + esc(perkDesc) + '</span>' +
                    '<button class="small" data-action="forgeApplyCrystal" data-slot="' + forgeSelectedSlot + '" data-id="' + cr.inventoryId + '" data-num-id="1">Apply</button></div>';
                }).join('')}
              </div>`;
            }
            html += `</div>`;
          }
        }
      } else {
        html += `<div class="ah-detail-empty">Select equipment to work with</div>`;
      }
      html += `</div></div>`;
      return html;
    }
    function setHomeRecipeFilter(filter) { homeRecipeFilter = filter; selectedRecipeSlug = null; craftQty = 1; renderStoryPanel(); }
    function selectRecipe(slug) { selectedRecipeSlug = slug || null; craftQty = 1; renderStoryPanel(); }
    function setCraftQty(qty) { craftQty = Math.max(1, qty); renderStoryPanel(); }

    function askQuantity(maxQty, label) {
      // Synchronous fallback — prefer appQuantityPicker for async contexts
      if (maxQty <= 1) return 1;
      return appQuantityPicker(label, maxQty, maxQty);
    }

    function appQuantityPicker(label, maxQty, defaultQty = 1) {
      if (maxQty <= 1) return Promise.resolve(1);
      return new Promise(resolve => {
        let qty = Math.min(defaultQty, maxQty);
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        const cleanup = (result) => { overlay.remove(); resolve(result); };
        overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
        const render = () => {
          const inner = overlay.querySelector('.qty-picker-val');
          if (inner) inner.textContent = qty;
          const totalEl = overlay.querySelector('.qty-picker-total');
          if (totalEl) totalEl.textContent = qty;
        };
        overlay.innerHTML = `
          <div class="confirm-dialog" style="max-width:340px">
            <div class="confirm-msg">${label}</div>
            <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:16px">
              <button class="secondary small qty-pick-btn" data-delta="-10" style="min-width:40px;border-radius:10px">-10</button>
              <button class="secondary small qty-pick-btn" data-delta="-1" style="min-width:36px;border-radius:10px">−</button>
              <div style="min-width:60px;text-align:center;font-family:'Fira Code',monospace;font-size:1.2rem;font-weight:700;color:var(--gold)" class="qty-picker-val">${qty}</div>
              <button class="secondary small qty-pick-btn" data-delta="1" style="min-width:36px;border-radius:10px">+</button>
              <button class="secondary small qty-pick-btn" data-delta="10" style="min-width:40px;border-radius:10px">+10</button>
            </div>
            <div style="display:flex;gap:6px;justify-content:center;margin-bottom:16px">
              <button class="secondary small qty-pick-set" data-val="1" style="border-radius:8px">Min</button>
              <button class="secondary small qty-pick-set" data-val="${Math.floor(maxQty/2)||1}" style="border-radius:8px">Half</button>
              <button class="secondary small qty-pick-set" data-val="${maxQty}" style="border-radius:8px">Max (${maxQty})</button>
            </div>
            <div style="text-align:center;font-size:.82rem;color:var(--muted);margin-bottom:14px">
              Quantity: <span class="qty-picker-total" style="color:var(--gold);font-weight:600">${qty}</span> / ${maxQty}
            </div>
            <div class="confirm-buttons">
              <button class="confirm-no">Cancel</button>
              <button class="confirm-yes">Confirm</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.confirm-no').onclick = () => cleanup(null);
        overlay.querySelector('.confirm-yes').onclick = () => cleanup(qty);
        overlay.querySelectorAll('.qty-pick-btn').forEach(btn => {
          btn.onclick = () => { qty = Math.max(1, Math.min(maxQty, qty + Number(btn.dataset.delta))); render(); };
        });
        overlay.querySelectorAll('.qty-pick-set').forEach(btn => {
          btn.onclick = () => { qty = Math.max(1, Math.min(maxQty, Number(btn.dataset.val))); render(); };
        });
        overlay.querySelector('.confirm-yes').focus();
      });
    }

    // ── State management: full replace or partial patch merge ──
    function applyState(res) {
      const prevRealms = state?.unlockedRealms;
      if (res.state) {
        // Full state replace (from /api/fantasy/state, travel, combat victory, etc.)
        state = res.state;
      } else if (res.patch && state) {
        // Partial patch — merge into existing state (shallow merge at top level)
        for (const key of Object.keys(res.patch)) {
          state[key] = res.patch[key];
        }
      }
      // Invalidate layout cache if unlocked realms changed
      if (JSON.stringify(prevRealms) !== JSON.stringify(state?.unlockedRealms)) {
        invalidateLayoutCache();
      }
      // Update last-seen log ID for toast detection
      if (state?.log?.length) {
        const maxId = Math.max(...state.log.map(e => e.id || 0));
        if (maxId > 0) _lastSeenLogId = maxId;
      }
    }

    async function refresh() {
      lastMessages = []; lastCombatLog = [];
      const res = await api('/api/fantasy/state');
      applyState(res);
      if (!state.hasCharacter) renderCreateView(); else renderGame();
    }

    async function init() {
      audioInit();
      try {
        const [dataRes, stateRes] = await Promise.all([api('/api/fantasy/data'), api('/api/fantasy/state')]);
        gameData = dataRes;
        state = stateRes.state;
        // Set initial log ID so we don't toast old entries on first load
        if (state?.log?.length) {
          _lastSeenLogId = Math.max(...state.log.map(e => e.id || 0));
        }
        selectedRace = gameData.races[0]?.slug || null;
        selectedClass = gameData.classes[0]?.slug || null;
        if (!state.hasCharacter) renderCreateView(); else {
          checkTutorialReset();
          // Always start SSE for invite notifications
          startSSE();
          // Restore party/raid state on page load
          if (state.partyId) {
            if (state.raidState?.phase) {
              partyRaidState = state.raidState;
              partyCombatData = state.partyCombat || null;
              storyView = 'raidTower';
            }
          }
          renderGame();
        }
      } catch (err) { showMessage(err.message || 'Failed to load the game.', true); }
    }

    // AH price input — delegated since it's dynamically rendered
    document.addEventListener('input', (e) => {
      if (e.target.id === 'ahPriceInput') {
        ahSellPrice = e.target.value;
      }
      if (e.target.id === 'musicVolumeSlider') {
        audioSetVolume(parseInt(e.target.value) / 100);
        e.target.title = `Volume ${e.target.value}%`;
      }
    });
    document.addEventListener('change', (e) => {
      if (e.target.id === 'ahPriceInput') {
        ahSellPrice = e.target.value;
        renderGame();
      }
    });

    $('createBtn')?.addEventListener('click', async () => {
      try {
        const name = $('charName').value.trim();
        if (!name) throw new Error('Enter a character name.');
        if (!selectedRace || !selectedClass) throw new Error('Select a race and class.');
        const res = await post('/api/fantasy/create', { name, race: selectedRace, class: selectedClass });
        applyState(res); lastMessages = [];
        showMessage('Character created. Your adventure begins.');
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    });

    // ── Unified action handler ──
    let pendingCombatResult = null;

    async function act(promise, successMsg = '') {
      try {
        const res = await promise;
        const prevLogId = _lastSeenLogId;
        applyState(res);
        detectAndToast(res, prevLogId);
        lastMessages = res.messages || [];
        if (res.combatLog?.length && !res.combatOver) {
          lastMessages = [...lastMessages, ...res.combatLog.slice(-6)];
          // Mid-combat durability popup notifications
          for (const line of res.combatLog) {
            if (line.includes('🚨') && line.includes('durability')) {
              showDurabilityToast(line, 'warn');
            } else if (line.includes('🤡')) {
              showDurabilityToast(line, 'noob');
            } else if (line.includes('💥') && line.includes('broke')) {
              showDurabilityToast(line, 'broke');
            }
          }
        }
        // Show combat result overlay when combat ends (skip for arena wave clears and raid advances — handled by their own screens)
        if (res.combatOver && !res.arenaWaveClear && !res.raidAdvance) {
          pendingCombatResult = {
            victory: res.victory, fled: res.fled, log: res.combatLog || [],
            arenaDefeat: res.arenaDefeat, arenaWave: res.arenaWave, arenaAp: res.arenaAp,
            raidDefeat: res.raidDefeat,
          };
        }
        if (successMsg && !lastMessages.length) showMessage(successMsg);
        else $('message').classList.add('hidden');
        if (storyView === 'market' && !state.shop) storyView = 'menu';
        if (storyView === 'guild' && !state.guild?.hasBountyBoard) storyView = 'menu';
        if (storyView === 'academy') storyView = 'classTrainer'; // Academy merged into class trainer
        if (storyView === 'auction' && !state.hasAuctionHouse) storyView = 'menu';
        if (storyView === 'home' && !state.home?.isAtHome && !state.home?.canCraftHere) storyView = 'menu';
        if (storyView === 'arenaStore' && !state.hasArena) storyView = 'menu';
        if (storyView === 'raidTower' && !state.hasRaidTower) storyView = 'menu';
        if (storyView === 'classTrainer' && !state.hasClassTrainer) storyView = 'menu';
        if (storyView === 'progression' && !progressionData) storyView = 'menu';
        if (storyView === 'codex') storyView = 'menu'; // codex is now a modal
        if (!state.hasCharacter) renderCreateView();
        else renderGame();
        // Combat animations after DOM update
        if (res.combatLog?.length) triggerCombatAnimations(res);
        if (pendingCombatResult) showCombatResultOverlay(pendingCombatResult);
      } catch (err) { showMessage(err.message, true); ensureLoadingCleared(); }
    }

    async function travel(dest) { closeWorldMap(); storyView = 'menu'; questMode = null; lastMessages = []; await act(post('/api/fantasy/travel', { destination: dest }), 'You travel onward.'); }
    async function travelPath(dest) {
      closeWorldMap();
      storyView = 'menu';
      questMode = null;
      lastMessages = [];
      await act(post('/api/fantasy/travel-path', { destination: dest }), 'You travel onward.');
    }
    async function travelHome() {
      storyView = 'menu'; lastMessages = [];
      await act(post('/api/fantasy/travel-path', { destination: 'thornwall' }), 'You return home to Thornwall.');
    }

    // ══════════════════════════════════════════
    //  FRIENDS LIST OVERLAY
    // ══════════════════════════════════════════
    let friendsData = null;
    let friendsOpen = false;
    let friendsTab = 'friends'; // 'friends' | 'party'

    async function openFriends() {
      if (friendsOpen) { closeFriends(); return; }
      friendsOpen = true;
      friendsData = null;
      renderFriendsOverlay();
      await loadFriends();
    }
    function closeFriends() {
      friendsOpen = false;
      _addFriendOpen = false;
      if (_invitePollTimer) { clearInterval(_invitePollTimer); _invitePollTimer = null; }
      const el = document.getElementById('friendsOverlay');
      if (el) el.remove();
    }
    let _invitePollTimer = null;
    function setFriendsTab(tab) {
      friendsTab = tab;
      // Start/stop invite polling when on party tab without a party
      if (tab === 'party' && !partyData && !_invitePollTimer) {
        _invitePollTimer = setInterval(async () => {
          if (!friendsOpen || friendsTab !== 'party' || partyData) { clearInterval(_invitePollTimer); _invitePollTimer = null; return; }
          try {
            const resp = await fetch('/api/fantasy/party/poll', { credentials: 'include' });
            if (resp.ok) {
              const data = await resp.json();
              partyInvites = data.pendingInvites || [];
              if (data.party) { partyData = data.party; startPartyPolling(); clearInterval(_invitePollTimer); _invitePollTimer = null; }
              renderFriendsOverlay();
            }
          } catch(e) {}
        }, 5000);
      } else if (tab !== 'party' && _invitePollTimer) {
        clearInterval(_invitePollTimer); _invitePollTimer = null;
      }
      renderFriendsOverlay();
    }
    async function loadFriends() {
      try {
        const resp = await fetch('/api/fantasy/friends', { credentials: 'include' });
        if (resp.ok) { friendsData = await resp.json(); }
        // Always refresh party state on panel open. Even with SSE active, any
        // missed event would leave partyData stale — opening the panel is the
        // user's implicit "show me what's happening now" signal.
        try {
          const pollResp = await fetch('/api/fantasy/party/poll', { credentials: 'include' });
          if (pollResp.ok) {
            const pollData = await pollResp.json();
            partyInvites = pollData.pendingInvites || [];
            // pollData.party is null when char has no party
            partyData = pollData.party || null;
            if (partyData && !partyEventSource) startPartyPolling();
          }
        } catch (_) {}
        renderFriendsOverlay();
      } catch(e) {}
    }
    let _addFriendOpen = false;
    function addFriend() { _addFriendOpen = !_addFriendOpen; renderFriendsOverlay(); }
    async function submitAddFriend() {
      const input = document.getElementById('addFriendInput');
      const name = input?.value?.trim();
      if (!name) return;
      try {
        const res = await post('/api/fantasy/friends/add', { name });
        showToast('info', 'Friends', res.message || 'Request sent!');
        _addFriendOpen = false;
        await loadFriends();
      } catch (err) { showMessage(err.message, true); }
    }
    async function acceptFriend(id) {
      try {
        const res = await post('/api/fantasy/friends/accept', { friendshipId: Number(id) });
        showToast('info', 'Friends', res.message || 'Accepted!');
        await loadFriends();
      } catch (err) { showMessage(err.message, true); }
    }
    async function removeFriend(id) {
      try {
        const res = await post('/api/fantasy/friends/remove', { friendshipId: Number(id) });
        showToast('info', 'Friends', res.message || 'Removed.');
        await loadFriends();
      } catch (err) { showMessage(err.message, true); }
    }

    function renderFriendsOverlay() {
      let el = document.getElementById('friendsOverlay');
      if (!el) {
        el = document.createElement('div');
        el.id = 'friendsOverlay';
        el.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:320px;max-width:90vw;background:var(--bg);border-left:1px solid var(--border);z-index:1100;overflow-y:auto;padding:16px;box-shadow:-4px 0 20px rgba(0,0,0,.5);animation:slideInRight .2s ease';
        document.body.appendChild(el);
      }

      const CLASS_ICONS = { warrior: '⚔', mage: '🔮', rogue: '🗡', cleric: '✝', ranger: '🏹' };

      if (!friendsData) {
        el.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <div class="eyebrow">👥 FRIENDS</div>
            <button class="secondary small" data-action="closeFriends" style="padding:4px 10px">✕</button>
          </div>
          <div class="muted" style="text-align:center;padding:20px 0">Loading...</div>`;
        return;
      }

      const { friends, incoming, outgoing } = friendsData;
      const hasParty = !!partyData;
      let html = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="eyebrow">👥 SOCIAL</div>
          <button class="secondary small" data-action="closeFriends" style="padding:4px 10px">✕</button>
        </div>
        <div style="display:flex;gap:2px;margin-bottom:14px;padding:3px;background:rgba(255,255,255,.04);border-radius:10px;border:1px solid var(--line)">
          <button class="${friendsTab === 'friends' ? '' : 'secondary'} small" data-action="setFriendsTab" data-tab="friends" style="flex:1;border-radius:8px;${friendsTab === 'friends' ? '' : 'box-shadow:none;border-color:transparent'}">👥 Friends (${friends.length})</button>
          <button class="${friendsTab === 'party' ? '' : 'secondary'} small" data-action="setFriendsTab" data-tab="party" style="flex:1;border-radius:8px;${friendsTab === 'party' ? 'background:linear-gradient(135deg,#0d6949,#14b8a6);' : 'box-shadow:none;border-color:transparent'}">${hasParty ? '⚔' : '👥'} Party${hasParty ? ' (' + partyData.members.length + ')' : ''}</button>
        </div>`;

      if (friendsTab === 'party') {
        html += renderPartyTab();
        el.innerHTML = html;
        return;
      }

      // ── FRIENDS TAB ──
      html += `
        <button class="small" data-action="addFriend" style="width:100%;margin-bottom:${_addFriendOpen ? '8px' : '14px'}">${_addFriendOpen ? '✕ Cancel' : '+ Add Friend'}</button>
        ${_addFriendOpen ? `<div style="display:flex;gap:6px;margin-bottom:14px">
          <input type="text" id="addFriendInput" placeholder="Character name..." style="flex:1;padding:8px 12px;font-size:.85rem;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--text)" />
          <button class="green small" data-action="submitAddFriend" style="padding:6px 14px">Send</button>
        </div>` : ''}`;

      // Incoming requests
      if (incoming.length > 0) {
        html += `<div class="label" style="margin-bottom:6px;color:#fbbf24">📨 INCOMING REQUESTS (${incoming.length})</div>`;
        for (const f of incoming) {
          html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.15);border-radius:8px;margin-bottom:6px">
            <div>
              <span style="font-weight:600">${esc(f.name)}</span>
              <span class="muted" style="font-size:.75rem"> ${CLASS_ICONS[f.class]||''} Lv${f.level}</span>
            </div>
            <div style="display:flex;gap:4px">
              <button class="green small" data-action="acceptFriend" data-id="${f.friendshipId}" style="padding:2px 8px">✓</button>
              <button class="secondary small" data-action="removeFriend" data-id="${f.friendshipId}" style="padding:2px 8px;color:var(--ember)">✕</button>
            </div>
          </div>`;
        }
      }

      // Outgoing requests
      if (outgoing.length > 0) {
        html += `<div class="label" style="margin:10px 0 6px;color:var(--muted)">📤 SENT REQUESTS (${outgoing.length})</div>`;
        for (const f of outgoing) {
          html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:6px;opacity:.7">
            <div>
              <span>${esc(f.name)}</span>
              <span class="muted" style="font-size:.75rem"> ${CLASS_ICONS[f.class]||''} Lv${f.level}</span>
            </div>
            <button class="secondary small" data-action="removeFriend" data-id="${f.friendshipId}" style="padding:2px 8px;font-size:.7rem">Cancel</button>
          </div>`;
        }
      }

      // Friends list
      if (friends.length === 0 && incoming.length === 0 && outgoing.length === 0) {
        html += `<div class="muted" style="text-align:center;padding:20px 0">No friends yet. Add someone by name!</div>`;
      } else if (friends.length > 0) {
        html += `<div class="label" style="margin:10px 0 6px">FRIENDS</div>`;
        for (const f of friends) {
          const onlineDot = f.online
            ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:4px" title="Online"></span>'
            : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#555;margin-right:4px" title="Offline"></span>';
          html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:5px">
            <div style="display:flex;align-items:center;gap:6px">
              ${onlineDot}
              <div>
                <div style="font-weight:600;font-size:.9rem">${esc(f.name)}</div>
                <div class="muted" style="font-size:.72rem">${CLASS_ICONS[f.class]||''} ${(f.class||'?').charAt(0).toUpperCase()+(f.class||'?').slice(1)} · Lv${f.level}${f.online ? ' · ' + esc(f.location || '?') : ''}</div>
              </div>
            </div>
            <div style="display:flex;gap:3px">
              ${f.online && partyData && partyData.leaderId === state.character?.id && partyData.members.length < 5 ? `<button class="small" data-action="partyInviteFriend" data-id="${f.charId}" style="padding:2px 6px;font-size:.65rem;background:#0d9488">Invite</button>` : ''}
              <button class="secondary small" data-action="removeFriend" data-id="${f.friendshipId}" style="padding:2px 6px;font-size:.65rem;opacity:.5">✕</button>
            </div>
          </div>`;
        }
      }

      el.innerHTML = html;
      const addInput = document.getElementById('addFriendInput');
      if (addInput) {
        addInput.focus();
        addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAddFriend(); });
      }
    }

    // ── Party Tab (inside friends overlay) ──
    function renderPartyTab() {
      const c = state.character;
      const CLASS_ICONS = { warrior: '⚔', mage: '🔮', rogue: '🗡', cleric: '✝', ranger: '🏹' };
      let html = '';

      // Pending invites (show even without a party)
      if (partyInvites && partyInvites.length > 0 && !partyData) {
        html += `<div style="background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.15);border-radius:12px;padding:12px;margin-bottom:14px">
          <div class="label" style="color:#fbbf24;margin-bottom:6px">📨 PARTY INVITES</div>`;
        for (const inv of partyInvites) {
          html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0">
            <span>${esc(inv.from_name)} (${CLASS_ICONS[inv.from_class]||''} Lv${inv.from_level})</span>
            <div style="display:flex;gap:4px">
              <button class="green small" data-action="partyAccept" data-id="${inv.invite_id}">Join</button>
              <button class="secondary small" data-action="partyDecline" data-id="${inv.invite_id}">✕</button>
            </div>
          </div>`;
        }
        html += `</div>`;
      }

      if (!partyData) {
        // No party
        html += `<div style="text-align:center;padding:20px 0">
          <div class="muted" style="margin-bottom:12px">You are not in a party.</div>
          <button class="primary-action" data-action="partyCreate" style="width:100%">⚔ Create Raid Party</button>
          <div class="muted" style="margin-top:6px;font-size:.82rem">Form a party, invite friends, and run raids together — from anywhere.</div>
        </div>`;
        return html;
      }

      // ── Active party ──
      const p = partyData;
      const isLeader = p.leaderId === c.id;
      const me = p.members.find(m => m.charId === c.id);
      const stateLabel = p.state === 'forming' ? 'FORMING' : p.state === 'lobby' ? 'LOBBY' : p.state === 'in_raid' ? 'IN RAID' : p.state.toUpperCase();
      const stateColor = p.state === 'lobby' ? '#14b8a6' : p.state === 'in_raid' ? '#ef4444' : '#94a3b8';

      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div class="label" style="color:${stateColor}">RAID PARTY (${p.members.length}/5) — ${stateLabel}</div>
        ${isLeader ? '<span style="font-size:.7rem;color:#fbbf24;font-weight:600">★ LEADER</span>' : ''}
      </div>`;

      // Selected raid banner (lobby or in_raid)
      if ((p.state === 'lobby' || p.state === 'in_raid') && p.raidSlug) {
        const raid = (raidListData?.raids || []).find(r => r.slug === p.raidSlug);
        html += `<div style="background:linear-gradient(135deg,#0f766e,#14b8a6);border-radius:10px;padding:10px 12px;margin-bottom:10px;color:#e0f2fe">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="font-size:.65rem;opacity:.8;letter-spacing:.08em;text-transform:uppercase">${p.state === 'in_raid' ? 'RAID IN PROGRESS' : 'RAID SELECTED'}</div>
              <div style="font-size:1rem;font-weight:700">${raid ? esc(raid.icon || '🕳') + ' ' + esc(raid.name) : esc(p.raidSlug)}</div>
              ${raid ? `<div style="font-size:.72rem;opacity:.85">${raid.floors} floors · Level ${raid.levelReq}+</div>` : ''}
            </div>
            ${isLeader && p.state === 'lobby' ? `<button class="secondary small" data-action="partyCancelLobby" style="font-size:.7rem;padding:3px 8px">Change</button>` : ''}
          </div>
        </div>`;
      }

      // Members — state-aware status indicators
      for (const m of p.members) {
        let statusIcon = '·', statusColor = '#888', statusText = '';
        if (p.state === 'forming') {
          statusIcon = m.isLeader ? '★' : '·';
          statusColor = m.isLeader ? '#fbbf24' : '#888';
        } else if (p.state === 'lobby') {
          if (!m.lobbyJoined) { statusIcon = '⏳'; statusColor = '#888'; statusText = 'Not joined'; }
          else if (m.ready) { statusIcon = '✓'; statusColor = '#22c55e'; statusText = 'Ready'; }
          else { statusIcon = '⏱'; statusColor = '#fbbf24'; statusText = 'Joined, not ready'; }
        } else if (p.state === 'in_raid') {
          const hpPct = Math.round((m.hp / m.maxHp) * 100);
          statusIcon = hpPct > 50 ? '⚔' : hpPct > 0 ? '🩸' : '💀';
          statusColor = hpPct > 50 ? '#22c55e' : hpPct > 0 ? '#fbbf24' : '#ef4444';
          statusText = `HP ${m.hp}/${m.maxHp}`;
        }
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:4px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="color:${statusColor};font-weight:700;width:16px;text-align:center">${statusIcon}</span>
            <div>
              <div style="font-weight:600;font-size:.85rem">${CLASS_ICONS[m.class]||''} ${esc(m.name)}${m.isLeader ? ' <span style="font-size:.62rem;color:#fbbf24">★</span>' : ''}</div>
              <div class="muted" style="font-size:.68rem">${(m.class||'').charAt(0).toUpperCase()+(m.class||'').slice(1)} Lv${m.level}${statusText ? ' · ' + statusText : ''}</div>
            </div>
          </div>
          ${isLeader && !m.isLeader && p.state !== 'in_raid' ? `<button class="secondary small" data-action="partyKick" data-id="${m.charId}" style="padding:2px 6px;font-size:.65rem;opacity:.5">✕</button>` : ''}
        </div>`;
      }

      // Pending invites sent
      if (isLeader && p.invites.length > 0) {
        html += `<div class="muted" style="font-size:.72rem;margin-top:6px">Pending invites: ${p.invites.map(i => esc(i.toName)).join(', ')}</div>`;
      }

      // Actions by state
      html += `<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">`;

      if (p.state === 'forming') {
        if (isLeader) {
          if (p.members.length < 5) {
            html += `<button class="small" data-action="openPartyInvite">${_partyInviteList ? '✕ Close' : '+ Invite'}</button>`;
          }
          if (p.members.length >= 2) {
            html += `<button class="primary-action small" data-action="togglePartyRaidPicker" style="background:linear-gradient(135deg,#0d9488,#14b8a6);padding:6px 12px;font-size:.78rem">${_partyRaidPickerOpen ? '✕ Close Picker' : '🎯 Select Raid'}</button>`;
          }
        }
      } else if (p.state === 'lobby') {
        if (isLeader) {
          const allJoined = p.members.every(m => m.lobbyJoined);
          const allReady = p.members.every(m => m.ready);
          if (me?.lobbyJoined) {
            html += `<button class="${me.ready ? 'secondary' : 'green'} small" data-action="partyReady">${me.ready ? '⏳ Unready' : '✓ Ready'}</button>`;
          }
          if (allJoined && allReady) {
            html += `<button class="primary-action small" data-action="partyStartRaid" style="background:linear-gradient(135deg,#b91c1c,#dc2626);padding:6px 12px;font-size:.78rem">⚔ Start Raid</button>`;
          } else {
            const waitingFor = p.members.filter(m => !m.lobbyJoined).map(m => m.name)
              .concat(p.members.filter(m => m.lobbyJoined && !m.ready).map(m => m.name + ' (not ready)'));
            html += `<button class="primary-action small" disabled style="opacity:.45;cursor:not-allowed;padding:6px 12px;font-size:.78rem" title="Waiting for: ${esc(waitingFor.join(', '))}">⚔ Start Raid</button>`;
          }
        } else {
          if (!me?.lobbyJoined) {
            html += `<button class="green" data-action="partyJoinLobby" style="padding:6px 14px">🚪 Join Lobby</button>`;
          } else {
            html += `<button class="${me.ready ? 'secondary' : 'green'} small" data-action="partyReady">${me.ready ? '⏳ Unready' : '✓ Ready'}</button>`;
          }
        }
      }
      // in_raid: no ready/start actions
      html += `<button class="secondary small" data-action="partyLeave" style="color:var(--ember)" ${p.state === 'in_raid' ? 'disabled title="Cannot leave mid-raid"' : ''}>${isLeader ? '🗑 Disband' : '🚪 Leave'}</button>`;
      html += `</div>`;

      // Inline raid picker (leader, forming)
      if (isLeader && p.state === 'forming' && _partyRaidPickerOpen) {
        const raids = raidListData?.raids || [];
        if (raids.length === 0) {
          html += `<div style="margin-top:10px;padding:10px;background:rgba(20,184,166,.04);border:1px solid rgba(20,184,166,.12);border-radius:10px;text-align:center;font-size:.82rem;color:var(--muted);font-style:italic">Loading raids...</div>`;
        } else {
          html += `<div style="margin-top:10px;padding:10px;background:rgba(20,184,166,.04);border:1px solid rgba(20,184,166,.12);border-radius:10px">
            <div class="label" style="margin-bottom:8px">CHOOSE A RAID</div>`;
          for (const raid of raids) {
            const minLevel = raid.levelReq || 1;
            const somebodyLow = p.members.some(m => m.level < minLevel);
            html += `<button class="arena-choice-card" data-action="partySelectRaid" data-slug="${raid.slug}" style="width:100%;text-align:left;padding:10px 12px;margin-bottom:6px;${somebodyLow ? 'opacity:.45;pointer-events:none' : ''}">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
                <div style="min-width:0">
                  <div style="font-weight:700">${esc(raid.icon || '🕳')} ${esc(raid.name)}</div>
                  <div class="muted" style="font-size:.7rem">${raid.floors} floors · Level ${minLevel}+${raid.difficulty ? ' · ' + esc(raid.difficulty) : ''}</div>
                </div>
                ${somebodyLow ? `<span style="font-size:.68rem;color:#ef4444;white-space:nowrap">Need Lv${minLevel}</span>` : ''}
              </div>
            </button>`;
          }
          html += `</div>`;
        }
      }

      // Inline invite list (leader, not in_raid)
      if (isLeader && _partyInviteList && p.state !== 'in_raid') {
        if (_partyInviteList.length === 0) {
          html += `<div style="margin-top:10px;padding:10px;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:10px;text-align:center;font-size:.82rem;color:var(--muted);font-style:italic">No friends online to invite.</div>`;
        } else {
          html += `<div style="margin-top:10px;padding:10px;background:rgba(20,184,166,.04);border:1px solid rgba(20,184,166,.12);border-radius:10px">
            <div class="muted" style="font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Online Friends</div>`;
          for (const f of _partyInviteList) {
            html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:4px">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:#22c55e;font-size:.6rem">●</span>
                <div>
                  <div style="font-weight:600;font-size:.85rem">${CLASS_ICONS[f.class]||''} ${esc(f.name)}</div>
                  <div class="muted" style="font-size:.68rem">${(f.class||'').charAt(0).toUpperCase()+(f.class||'').slice(1)} Lv${f.level}</div>
                </div>
              </div>
              <button class="green small" data-action="partyInviteFriend" data-id="${f.charId}" style="padding:3px 10px;font-size:.72rem">Invite</button>
            </div>`;
          }
          html += `</div>`;
        }
      }

      return html;
    }

    //  WORLD MAP OVERLAY
    // ══════════════════════════════════════════
    let miniMapRealm = null; // null = auto-detect from current realm

    function switchMiniRealm(slug) {
      miniMapRealm = slug;
      renderNavPanel();
    }

    function openWorldMap() {
      const existing = document.getElementById('worldmapOverlay');
      if (existing) { existing.remove(); return; }
      renderWorldMap();
    }
    function closeWorldMap() {
      const el = document.getElementById('worldmapOverlay');
      if (el) el.remove();
    }
    function setWorldMapRealm(slug) {
      worldMapRealm = slug;
      closeWorldMap();
      renderWorldMap();
    }

    let worldMapRealm = null; // null = auto-detect from current location

    function renderWorldMap() {
      const c = state.character;
      const allLocations = state.locations || [];
      const threats = state.locationThreat || {};
      const currentSlug = c.location;
      const realms = gameData.realms || [];
      const unlockedRealms = state.unlockedRealms || ['ashlands'];
      const currentRealm = state.currentRealm || 'ashlands';
      const selectedRealm = worldMapRealm || currentRealm;

      // Get graph layout for selected realm
      const { positions, portalNodes } = getRealmLayout(selectedRealm, allLocations, realms, unlockedRealms);
      const realmLocs = allLocations.filter(l => (l.realm || 'ashlands') === selectedRealm);
      const allMapNodes = [...realmLocs, ...portalNodes];

      const currentLoc = allLocations.find(l => l.slug === currentSlug);
      const adjacentSlugs = new Set(currentLoc?.connections || []);

      // Inject portal connections for unlocked realms
      for (const realm of realms) {
        if (!unlockedRealms.includes(realm.slug)) continue;
        if (realm.portalFromLocation && realm.portalToLocation) {
          adjacentSlugs.add(realm.portalToLocation);
          adjacentSlugs.add(realm.portalFromLocation);
        }
      }

      // Build adjacency for BFS (include home shortcut + portal links)
      const adjMap = {};
      for (const loc of allLocations) adjMap[loc.slug] = [...(loc.connections || [])];
      for (const realm of realms) {
        if (!unlockedRealms.includes(realm.slug)) continue;
        if (realm.portalFromLocation && realm.portalToLocation) {
          if (adjMap[realm.portalFromLocation]) adjMap[realm.portalFromLocation].push(realm.portalToLocation);
          if (adjMap[realm.portalToLocation]) adjMap[realm.portalToLocation].push(realm.portalFromLocation);
        }
      }
      for (const slug of Object.keys(adjMap)) {
        if (slug !== 'thornwall' && !adjMap[slug].includes('thornwall')) {
          adjMap[slug] = [...adjMap[slug], 'thornwall'];
        }
      }

      // BFS from current location to compute reachability and distances
      const dist = {};
      dist[currentSlug] = 0;
      const queue = [currentSlug];
      while (queue.length > 0) {
        const node = queue.shift();
        for (const nb of (adjMap[node] || [])) {
          if (dist[nb] === undefined) {
            dist[nb] = dist[node] + 1;
            queue.push(nb);
          }
        }
      }

      // Collect edges (realm-scoped, deduplicated)
      const edgeSet = new Set();
      const edges = [];
      for (const loc of allMapNodes) {
        for (const conn of (loc.connections || [])) {
          if (!positions.has(conn)) continue;
          const key = [loc.slug, conn].sort().join('|');
          if (!edgeSet.has(key)) { edgeSet.add(key); edges.push([loc.slug, conn]); }
        }
      }

      // Build overlay
      const overlay = document.createElement('div');
      overlay.id = 'worldmapOverlay';
      overlay.className = 'worldmap-overlay';
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeWorldMap(); });

      // Build SVG edges + node HTML
      let nodesHtml = '';
      let svgEdges = '';

      for (const [a, b] of edges) {
        const pa = positions.get(a);
        const pb = positions.get(b);
        if (!pa || !pb) continue;
        const isPathEdge = (a === currentSlug && adjacentSlugs.has(b)) || (b === currentSlug && adjacentSlugs.has(a));
        const isPortal = a.startsWith('_portal_') || b.startsWith('_portal_');
        svgEdges += `<line x1="${pa.x}%" y1="${pa.y}%" x2="${pb.x}%" y2="${pb.y}%" class="worldmap-edge${isPathEdge ? ' edge-path' : ''}${isPortal ? ' wm-portal-edge' : ''}" />`;
      }

      for (const loc of allMapNodes) {
        const pos = positions.get(loc.slug);
        if (!pos) continue;
        const isPortal = loc.slug.startsWith('_portal_');
        const isCurrent = loc.slug === currentSlug;
        const isAdjacent = adjacentSlugs.has(loc.slug);
        const isReachable = dist[loc.slug] !== undefined && !isCurrent;
        const threat = threats[loc.slug] || 1;
        const tCls = threatClass(threat, c.level);

        let nodeClass = 'worldmap-node';
        if (isCurrent) nodeClass += ' wm-current';
        else if (isPortal) nodeClass += ' wm-portal-node';
        else if (isAdjacent) nodeClass += ' wm-adjacent';
        else if (isReachable) nodeClass += ' wm-reachable';

        const hops = dist[loc.slug] || 0;
        const hopLabel = isCurrent ? 'You are here' : `${hops} hop${hops !== 1 ? 's' : ''}`;

        let clickAction = '';
        if (isPortal && loc.portalTarget) {
          clickAction = `data-action="setWorldMapRealm" data-value="${loc.portalTarget}"`;
        } else if (!isCurrent && !c.in_combat) {
          clickAction = isAdjacent ? `data-action="travel" data-dest="${loc.slug}"` : `data-action="travelPath" data-dest="${loc.slug}"`;
        }

        nodesHtml += `
          <div class="${nodeClass}" style="left:${pos.x}%;top:${pos.y}%${isCurrent ? ';cursor:default' : ''}" ${clickAction}>
            <span class="worldmap-node-icon">${locIcon(loc.type)}</span>
            <span class="worldmap-node-name">${esc(loc.name)}</span>
            ${isPortal ? '<span class="worldmap-node-meta">Portal</span>' : `<span class="worldmap-node-meta">${esc(loc.type)} · ${hopLabel}</span>
            <span class="worldmap-node-threat wm-threat-${tCls}">${threatIcon(tCls)} Lv ${threat} · ${threatLabel(threat, c.level)}</span>`}
          </div>`;
      }

      // Realm tabs
      const realmTabsHtml = unlockedRealms.length > 1 ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${
        realms.filter(r => unlockedRealms.includes(r.slug)).map(r =>
          `<button class="${r.slug === selectedRealm ? '' : 'secondary'} small" data-action="setWorldMapRealm" data-value="${r.slug}" style="font-size:.75rem;padding:4px 10px">${r.icon} ${esc(r.name)}${r.slug === currentRealm ? ' ◄' : ''}</button>`
        ).join('')
      }</div>` : '';

      const realmObj = realms.find(r => r.slug === selectedRealm);
      const realmDesc = realmObj ? `<div class="worldmap-realm-desc">${realmObj.icon} ${esc(realmObj.name)} — Lv ${realmObj.levelRange[0]}-${realmObj.levelRange[1]}</div>` : '';

      overlay.innerHTML = `
        <div class="worldmap-modal">
          <div class="worldmap-header">
            <h3>🗺 World Map</h3>
            <button class="secondary small" data-action="closeWorldMap">✕ Close</button>
          </div>
          <div class="worldmap-tabs-bar">
            ${realmTabsHtml}
            ${realmDesc}
          </div>
          <div class="worldmap-body">
            <div class="worldmap-canvas">
              <svg class="worldmap-svg" xmlns="http://www.w3.org/2000/svg">${svgEdges}</svg>
              ${nodesHtml}
            </div>
          </div>
        </div>`;

      document.body.appendChild(overlay);
    }

    async function explore() { storyView = 'menu'; await act(post('/api/fantasy/explore'), 'You venture into danger...'); }
    async function resolveEvent(idx) {
      try {
        const res = await post('/api/fantasy/event/resolve', { choiceIdx: Number(idx) });
        applyState(res);
        // outcome is stored in state.activeEvent.outcome now
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function dismissEvent() {
      try {
        const res = await post('/api/fantasy/event/dismiss');
        applyState(res);
        lastMessages = [];
        renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    let pendingPetAbility = null;
    async function combatAction(action, abilitySlug, itemSlug) {
      const body = { action };
      if (abilitySlug) body.abilitySlug = abilitySlug;
      if (itemSlug) body.itemSlug = itemSlug;
      if (combatTargetId) body.targetId = combatTargetId;
      if (pendingPetAbility) body.petAbility = pendingPetAbility;
      pendingPetAbility = null; // reset after send
      await act(post('/api/fantasy/combat/action', body));
    }
    function setCombatTarget(id) { combatTargetId = id; renderStoryPanel(); }
    function setPetAbility(slug) { pendingPetAbility = slug; renderStoryPanel(); }
    async function acceptQuest(questSlug) {
      await act(post('/api/fantasy/quest/accept', { questSlug }));
      // Enter quest mode on accept
      questMode = { slug: questSlug, showChoices: false, outcome: null };
      renderGame();
    }
    async function questChoice(questSlug, choiceIndex) {
      const prevActiveQuests = state.activeQuests.map(q => q.quest_slug);
      const res = await post('/api/fantasy/quest/choice', { questSlug, choiceIndex });
      const prevLogId = _lastSeenLogId;
      applyState(res);
      detectAndToast(res, prevLogId);
      lastMessages = res.messages || [];

      // Check if quest completed (was active, now gone)
      const stillActive = state.activeQuests.find(q => q.quest_slug === questSlug);
      if (!stillActive && prevActiveQuests.includes(questSlug)) {
        // Quest completed! Show completion overlay
        questMode = null;
        pendingQuestComplete = { title: '', messages: lastMessages };
        // Find title from messages
        for (const m of lastMessages) {
          const match = m.match(/Quest complete: (.+?)!/);
          if (match) { pendingQuestComplete.title = match[1]; break; }
        }
        renderGame();
        showQuestCompleteOverlay(pendingQuestComplete);
        return;
      }

      // Check if entering combat (quest combat trigger)
      if (state.character?.in_combat) {
        questMode = null;
        renderGame();
        return;
      }

      // Parse outcome from messages for the pass/fail moment
      if (lastMessages.length) {
        const outcome = { messages: [...lastMessages], rollInfo: null, success: null };
        for (const m of lastMessages) {
          const passMatch = m.match(/Stat check passed! \((\w+) d20:(\d+)([+-]\d+)=(\d+) vs DC (\d+)\)/);
          const failMatch = m.match(/Stat check failed! \((\w+) d20:(\d+)([+-]\d+)=(\d+) vs DC (\d+)\)/);
          if (passMatch) {
            outcome.success = true;
            outcome.rollInfo = { stat: passMatch[1], roll: parseInt(passMatch[2]), modifier: parseInt(passMatch[3]), total: parseInt(passMatch[4]), dc: parseInt(passMatch[5]) };
          } else if (failMatch) {
            outcome.success = false;
            outcome.rollInfo = { stat: failMatch[1], roll: parseInt(failMatch[2]), modifier: parseInt(failMatch[3]), total: parseInt(failMatch[4]), dc: parseInt(failMatch[5]) };
          }
        }
        // Filter out the stage narrative text from outcome messages (it's shown as next stage text)
        outcome.messages = outcome.messages.filter(m => m.includes('\u2713') || m.includes('\u26a0') || m.includes('XP') || m.includes('damage') || m.includes('gold') || m.includes('\u2694') || m.includes('appears') || m.includes('\ud83d\udce6'));
        if (outcome.rollInfo || outcome.messages.length) {
          questMode = { slug: questSlug, showChoices: false, outcome };
        } else {
          questMode = { slug: questSlug, showChoices: false, outcome: null };
        }
      } else {
        questMode = { slug: questSlug, showChoices: false, outcome: null };
      }
      $('message').classList.add('hidden');
      renderGame();
    }
    function questRevealChoices() { if (questMode) { questMode.showChoices = true; renderGame(); } }
    function questOutcomeContinue() { if (questMode) { questMode.outcome = null; questMode.showChoices = false; renderGame(); } }
    function leaveQuestMode() { questMode = null; lastMessages = []; renderGame(); }
    function enterQuestMode(slug) { questMode = { slug, showChoices: false, outcome: null }; renderGame(); }
    function showQuestCompleteOverlay(data) {
      const existing = document.getElementById('questCompleteOverlay');
      if (existing) existing.remove();
      const rewards = [];
      const storyLines = [];
      for (const m of (data.messages || [])) {
        if (m.includes('\ud83c\udfc6') || m.includes('Quest complete')) rewards.push({ cls: 'cr-quest', text: m });
        else if (m.includes('XP') && m.includes('+')) rewards.push({ cls: 'cr-xp', text: m });
        else if (m.includes('gold') && m.includes('+')) rewards.push({ cls: 'cr-gold', text: m });
        else if (m.includes('\ud83d\udce6') || m.includes('Received')) rewards.push({ cls: 'cr-loot', text: m });
        else if (m.includes('LEVEL UP') || m.includes('\u2b06')) rewards.push({ cls: 'cr-level', text: m });
        else if (m.includes('\ud83c\udf00') || m.includes('REALM UNLOCKED')) rewards.push({ cls: 'cr-level', text: m });
        else storyLines.push(m);
      }
      const overlay = document.createElement('div');
      overlay.className = 'quest-complete-overlay';
      overlay.id = 'questCompleteOverlay';
      overlay.innerHTML = `
        <div class="quest-complete-modal">
          <div class="qc-icon">\ud83c\udfc6</div>
          <div class="qc-title">QUEST COMPLETE</div>
          <div class="qc-quest-name">${esc(data.title)}</div>
          ${storyLines.length ? '<div class="qc-story">' + storyLines.map(l => '<div class="qc-story-line">' + esc(l) + '</div>').join('') + '</div>' : ''}
          ${rewards.length ? '<div class="cr-rewards">' + rewards.map(r => '<div class="cr-reward ' + r.cls + '">' + esc(r.text) + '</div>').join('') + '</div>' : ''}
          <button class="primary-action" data-action="dismissQuestComplete" style="align-self:center;margin-top:8px">Continue</button>
        </div>`;
      document.body.appendChild(overlay);
      pendingQuestComplete = null;
    }
    function dismissQuestComplete() {
      const overlay = document.getElementById('questCompleteOverlay');
      if (overlay) overlay.remove();
    }
    async function buyItem(itemSlug) { await act(post('/api/fantasy/shop/buy', { itemSlug })); }
    async function shopBuyback(indexStr) { await act(post('/api/fantasy/shop/buyback', { index: Number(indexStr) }), 'Item bought back.'); }
    async function sellItem(itemSlug, inventoryId, quantity) {
      const qty = parseInt(quantity, 10) || 1;
      await act(post('/api/fantasy/shop/sell', { itemSlug, inventoryId: inventoryId || undefined, quantity: qty }));
    }
    async function sellBulk(itemSlug, maxQty, sellPrice) {
      const qty = await appQuantityPicker(`Sell how many? (${sellPrice}g each)`, Number(maxQty), Number(maxQty));
      if (qty == null) return;
      await sellItem(itemSlug, null, qty);
    }
    async function sellAllJunk() {
      const junkItems = state.inventory.filter(i => i.junk && i.sell > 0);
      if (!junkItems.length) return;
      const totalValue = junkItems.reduce((sum, i) => sum + (i.sell * i.quantity), 0);
      const ok = await appConfirm(`Sell all ${junkItems.length} junk item${junkItems.length>1?'s':''} for <strong style="color:var(--gold)">${totalValue}g</strong>?`, 'Sell All', 'Cancel');
      if (!ok) return;
      for (const item of junkItems) {
        await post('/api/fantasy/shop/sell', { itemSlug: item.slug, inventoryId: item.inventoryId || undefined, quantity: item.quantity });
      }
      await refresh();
    }
    async function equip(itemSlug, inventoryId) {
      const body = { itemSlug };
      if (inventoryId) body.inventoryId = inventoryId;
      _tutDidEquip = true;
      await act(post('/api/fantasy/equip', body), 'Item equipped.');
    }
    async function unequip(slot) { await act(post('/api/fantasy/unequip', { slot }), 'Item unequipped.'); }
    async function restAtInn() { storyView = 'menu'; _tutDidRest = true; await act(post('/api/fantasy/rest'), 'You rest and recover.'); }
    async function useItem(itemSlug) { await act(post('/api/fantasy/use', { itemSlug }), 'Item used.'); }
    async function learnRecipe(itemSlug) { storyView = 'home'; await act(post('/api/fantasy/learn-recipe', { itemSlug })); }
    async function repair(slot) { await act(post('/api/fantasy/repair', { slot })); }
    async function repairAll() { await act(post('/api/fantasy/repair-all')); }
    async function toggleJunk(itemSlug) { await act(post('/api/fantasy/inventory/mark-junk', { itemSlug })); }
    async function storeItem(itemSlug, quantity = 1) { storyView = 'home'; await act(post('/api/fantasy/home/store', { itemSlug, quantity })); }
    async function withdrawItem(itemSlug, quantity = 1) { storyView = 'home'; await act(post('/api/fantasy/home/withdraw', { itemSlug, quantity })); }
    async function craftItem(recipeSlug, quantity = 1) { storyView = 'home'; await act(post('/api/fantasy/craft', { recipeSlug, quantity })); }
    async function upgradeHome() { storyView = 'home'; await act(post('/api/fantasy/home/upgrade')); }
    async function storeItemPrompt(itemSlug, maxQty) { const qty = await appQuantityPicker('Store how many?', maxQty, maxQty); if (qty != null) await storeItem(itemSlug, qty); }
    async function withdrawItemPrompt(itemSlug, maxQty) { const qty = await appQuantityPicker('Withdraw how many?', maxQty, maxQty); if (qty != null) await withdrawItem(itemSlug, qty); }
    async function vaultStore(slug, ds) {
      const inventoryId = ds.inventoryId || undefined;
      const qty = Number(ds.qty) || 1;
      if (qty > 1 && !inventoryId) {
        const picked = await appQuantityPicker('Store how many in vault?', qty, qty);
        if (picked == null) return;
        await act(post('/api/fantasy/vault/store', { itemSlug: slug, quantity: picked }), 'Stored in vault.');
      } else {
        await act(post('/api/fantasy/vault/store', { itemSlug: slug, inventoryId: inventoryId || undefined, quantity: 1 }), 'Stored in vault.');
      }
    }
    async function vaultWithdraw(slug, ds) {
      const vaultId = ds.vaultId || undefined;
      const qty = Number(ds.qty) || 1;
      if (qty > 1 && !vaultId) {
        const picked = await appQuantityPicker('Withdraw how many from vault?', qty, qty);
        if (picked == null) return;
        await act(post('/api/fantasy/vault/withdraw', { itemSlug: slug, quantity: picked }), 'Withdrawn from vault.');
      } else {
        await act(post('/api/fantasy/vault/withdraw', { itemSlug: slug, vaultId: vaultId || undefined, quantity: 1 }), 'Withdrawn from vault.');
      }
    }
    async function craftItemPrompt(recipeSlug, maxQty) { const qty = await appQuantityPicker('Craft how many batches?', maxQty, maxQty); if (qty != null) await craftItem(recipeSlug, qty); }
    async function leaveDungeon() { storyView = 'menu'; await act(post('/api/fantasy/dungeon/leave'), 'You retreat from the dungeon.'); }
    async function resetCharacter() {
      if (!await appConfirm('Delete this fantasy character and all progress? This cannot be undone.', 'Delete', 'Cancel')) return;
      storyView = 'menu';
      await act(post('/api/fantasy/reset'), 'Character deleted. Create a new legend.');
    }
    async function logout() {
      try { const res = await post('/api/logout'); window.location.href = res.redirect || '/'; }
      catch (err) { showMessage(err.message, true); }
    }

    // ── Profile menu ──
    function toggleProfileMenu(dsOrEvent, elOrDs, evt) {
      // Support both direct onclick(event) and data-action delegation(ds, el, event)
      const btn = elOrDs instanceof HTMLElement ? elOrDs : (dsOrEvent?.currentTarget || dsOrEvent?.target);
      if (evt) evt.stopPropagation();
      else if (dsOrEvent?.stopPropagation) dsOrEvent.stopPropagation();
      // Close any open menus first
      document.querySelectorAll('.profile-menu').forEach(m => m.classList.add('hidden'));
      // Find the menu inside the same .profile-wrap
      const wrap = btn?.closest?.('.profile-wrap');
      const menu = wrap?.querySelector('.profile-menu');
      if (!menu) return;
      const charName = state?.character?.name || 'Adventurer';
      const charInfo = state?.character ? `Lv ${state.character.level} ${state.character.race} ${state.character.class}` : '';
      const charList = state?.charList || [];
      const activeId = state?.character?.id;
      const canCreate = charList.length < (state?.maxChars || 10);

      let charListHtml = '';
      if (charList.length > 1) {
        charListHtml = charList.filter(c => c.id !== activeId).map(c =>
          `<button class="profile-menu-item" data-action="switchCharacter" data-char-id="${c.id}">
            <span class="pm-icon">⚔</span>
            <div style="flex:1">
              <div style="font-weight:600;font-size:.88rem">${esc(c.name)}</div>
              <div class="muted" style="font-size:.72rem">Lv ${c.level} ${esc(c.race)} ${esc(c.class)}</div>
            </div>
          </button>`
        ).join('');
      }

      menu.innerHTML = `
        <div style="padding:10px 14px 6px;border-bottom:1px solid var(--line);margin-bottom:4px">
          <div style="font-family:Cinzel,serif;font-weight:700;font-size:.95rem;color:var(--gold)">${esc(charName)}</div>
          <div class="muted" style="font-size:.78rem;margin-top:2px">${esc(charInfo)}</div>
          <div class="muted" style="font-size:.68rem;margin-top:2px">${charList.length}/${state?.maxChars || 10} characters</div>
        </div>
        ${charListHtml ? `<div class="label" style="padding:6px 14px 2px;font-size:.6rem">SWITCH TO</div>${charListHtml}<div class="profile-menu-divider"></div>` : ''}
        ${canCreate ? `<button class="profile-menu-item" data-action="newCharacter"><span class="pm-icon">✨</span> New Character</button>` : ''}
        <button class="profile-menu-item" data-action="logout"><span class="pm-icon">🚪</span> Logout</button>
        <div class="profile-menu-divider"></div>
        <button class="profile-menu-item pm-danger" data-action="deleteCharacter"><span class="pm-icon">💀</span> Delete Character</button>
      `;
      menu.classList.remove('hidden');
    }
    // Close menu when clicking anywhere else
    document.addEventListener('click', () => {
      document.querySelectorAll('.profile-menu').forEach(m => m.classList.add('hidden'));
    });
    async function switchCharacter(charId) {
      document.querySelectorAll('.profile-menu').forEach(m => m.classList.add('hidden'));
      try {
        const res = await post('/api/fantasy/switch-character', { charId });
        applyState(res);
        lastMessages = [];
        storyView = 'menu';
        if (!state.hasCharacter) renderCreateView();
        else renderGame();
      } catch (err) { showMessage(err.message, true); }
    }
    async function newCharacter() {
      document.querySelectorAll('.profile-menu').forEach(m => m.classList.add('hidden'));
      try {
        const res = await post('/api/fantasy/new-character');
        applyState(res);
        lastMessages = [];
        renderCreateView();
      } catch (err) { showMessage(err.message, true); }
    }
    // ═══════════════════════════════════════════════════════════════
    // EVENT DELEGATION — replaces inline onclick handlers
    // ═══════════════════════════════════════════════════════════════
    // Usage in templates: data-action="actionName" data-foo="bar"
    // The click handler looks up actionName in ACTION_MAP and calls it
    // with the element's dataset as the argument.

    const ACTION_MAP = {
      // Navigation
      explore, travel, travelPath, travelHome, enterMarket, leaveMarket, enterHome, leaveHome, resolveEvent, dismissEvent,
      enterArena, arenaNextWave, arenaChoice, leaveArena, enterArenaStore, leaveArenaStore, arenaStoreBuy, arenaStoreReroll, arenaStoreRerollSlot, selectArenaStoreSlot,
      enterRaidTower, leaveRaidTower,
      partyCreate, openPartyInvite, partyAccept, partyDecline, partyReady, partyLeave, partyKick, partyVoteKick, partyStartRaid, partyInviteFriend,
      togglePartyRaidPicker, partySelectRaid, partyCancelLobby, partyJoinLobby,
      partyRaidAdvance, partyRaidChoice, partyRaidFloorChoice, partyRaidDismiss, partyCombatAction, partyCombatAck,
      selectPartyEnemy, selectPartyAlly,
      enterClassTrainer, leaveClassTrainer, setClassTrainerTab, classTrainerAccept, classTrainerChoice, classTrainerSetAbility, classTrainerRespec,
      enterProgression, leaveProgression, setProgressionTab, claimWeeklyQuest, claimDailyLogin,
      enterCodex, leaveCodex, codexBack, codexNav,
      enterGuild, leaveGuild, enterAcademy, leaveAcademy, enterAuction, leaveAuction,
      leaveDungeon, dismissCombatResult, dismissTip, toggleProfileMenu,
      openFriends, closeFriends, addFriend, submitAddFriend, acceptFriend, removeFriend, setFriendsTab,
      openWorldMap, closeWorldMap, setWorldMapRealm, switchMiniRealm,
      // Market/Shop
      buyItem, sellItem, sellBulk, sellAllJunk, shopBuyback, setShopTab, setShopSlotFilter, selectShopItem,
      // Repair
      repair, repairAll,
      // Guild
      guildRegister, guildBuy, setGuildTab,
      acceptBounty, claimBounty, abandonBounty,
      // Auction House
      ahBuy, ahCancel, ahSelectSellItem, ahListItem, ahPrevPage, ahNextPage,
      ahSetSlotFilter: setAhSlotFilter, ahSetRarityFilter: setAhRarityFilter,
      ahSetSort: setAhSort, ahSetTab: setAhTab, selectAhListing,
      ahCancelSell: () => { ahSellItem = null; renderGame(); },
      // Combat
      combatAction, setCombatTarget, setPetAbility,
      // Quest
      acceptQuest, questChoice, questRevealChoices, questOutcomeContinue,
      leaveQuestMode, enterQuestMode, dismissQuestComplete,
      skipTutorial, tutorialContinue,
      // Inventory
      openInventoryModal, closeInventoryModal, selectInvItem,
      equipFromModal, unequipFromModal, useFromModal, toggleJunkFromModal,
      storeFromModal, learnFromModal, setInvFilter,
      // Home / Crafting
      setHomeTab, setHomeRecipeFilter, selectRecipe, selectForgeSlot, setForgeTab,
      forgeEnchant, forgeExtractPerks, forgeApplyCrystal,
      forgeSocketGem: forgeSocket, forgeExtractGem,
      setCraftQty, craftItem, upgradeHome,
      storeItemPrompt, withdrawItemPrompt, vaultStore, vaultWithdraw, selectHomeInvItem, storeAllMaterials,
      // Academy
      learnAbility, upgradeAbility, addToLoadout, removeFromLoadout, saveLoadout,
      setAcademyTab, setAcademyFilter, selectTalent, resetLoadout, setAcademyLoadoutMode,
      // Character creation
      selectRace, selectClass,
      // Character management
      switchCharacter, newCharacter,
      deleteCharacter: resetCharacter,
      // Recipe learning
      learnRecipe,
      // Rest
      rest: restAtInn,
      // Auth
      logout,
      // Misc navigation
      goToDuel: () => { if (state.character?.in_combat) { showMessage('Cannot duel during combat!', true); return; } window.location.href = '/duel'; },
      // Music controls
      musicToggle: () => { audioToggleMute(); renderGame(); },
    };

    document.addEventListener('click', (e) => {
      audioUnlock(); // Unlock Web Audio on first user interaction
      const el = e.target.closest('[data-action]');
      if (!el) return;
      if (_loading) { e.preventDefault(); return; } // Block all clicks while loading
      e.stopPropagation();
      _lastClickedEl = el; // Track for spinner display
      const action = el.dataset.action;
      const fn = ACTION_MAP[action];
      if (!fn) { console.warn('Unknown action:', action); return; }
      // Extract typed args from data-* attributes
      const ds = el.dataset;
      // Multi-arg actions checked FIRST (before generic single-arg patterns)
      if (action === 'combatAction') return combatAction(ds.type, ds.ability || undefined, ds.item || undefined);
      if (action === 'partyCombatAction') return partyCombatAction(ds.type, ds.ability || undefined);
      if (action === 'forgeSocketGem') return forgeSocket(ds.slot, Number(ds.idx), ds.gem);
      if (action === 'forgeExtractGem') return forgeExtractGem(ds.slot, Number(ds.idx));
      if (action === 'forgeEnchant') return forgeEnchant(ds.slot);
      if (action === 'forgeExtractPerks') return forgeExtractPerks(ds.slot);
      if (action === 'forgeApplyCrystal') return forgeApplyCrystal(ds.slot, ds.id);
      // Multi-arg: toggle junk (needs inventoryId for perked items)
      if (action === 'toggleJunkFromModal') return toggleJunkFromModal(ds.slug, ds.inventoryId ? Number(ds.inventoryId) : undefined);
      if (action === 'codexNav') return codexNav(ds.slug, ds.sub || null);
      if (action === 'classTrainerChoice') return classTrainerChoice(ds.slug, ds.idx);
      if (action === 'classTrainerSetAbility') return classTrainerSetAbility(ds.slug);
      if (action === 'classTrainerAccept') return classTrainerAccept(ds.slug);
      if (action === 'setTitle') return setTitle(ds.slug || '');
      if (action === 'claimWeeklyQuest') return claimWeeklyQuest(ds.slug);
      // Common single-arg patterns — pass the right value directly
      if (ds.slug !== undefined) return fn(ds.slug, ds);
      if (ds.slot !== undefined) return fn(ds.slot, ds);
      if (ds.id !== undefined) return fn(ds.numId ? Number(ds.id) : ds.id, ds);
      if (ds.dest !== undefined) return fn(ds.dest, ds);
      if (ds.tab !== undefined) return fn(ds.tab, ds);
      if (ds.filter !== undefined) return fn(ds.filter, ds);
      if (ds.charId !== undefined) return fn(Number(ds.charId), ds);
      if (ds.value !== undefined) return fn(ds.value, ds);
      // Multi-arg: quest choice
      if (action === 'questChoice') return questChoice(ds.quest, Number(ds.idx));
      if (action === 'resolveEvent') return resolveEvent(Number(ds.idx));
      // Multi-arg: sell item (with quantity)
      if (action === 'sellItem') return sellItem(ds.itemSlug, ds.inventoryId ? Number(ds.inventoryId) : undefined, Number(ds.qty) || 1);
      // Multi-arg: sell bulk (opens qty picker)
      if (action === 'sellBulk') return sellBulk(ds.itemSlug, ds.maxQty, ds.sellPrice);
      // Multi-arg: equip
      if (action === 'equipFromModal') return equipFromModal(ds.itemSlug, ds.inventoryId ? Number(ds.inventoryId) : undefined);
      // Multi-arg: store/withdraw prompts
      if (action === 'storeItemPrompt') return storeItemPrompt(ds.itemSlug, Number(ds.qty));
      if (action === 'withdrawItemPrompt') return withdrawItemPrompt(ds.itemSlug, Number(ds.qty));
      if (action === 'storeFromModal') return storeFromModal(ds.itemSlug, Number(ds.qty));
      // Multi-arg: craft
      if (action === 'craftItem') return craftItem(ds.recipe, Number(ds.qty));
      // Multi-arg: setCraftQty
      if (action === 'setCraftQty') return setCraftQty(Number(ds.qty));
      // (Forge actions handled above in multi-arg block)
      // Multi-arg: AH select sell
      if (action === 'ahSelectSellItem') return ahSelectSellItem(ds.itemSlug, ds.inventoryId === 'null' ? null : Number(ds.inventoryId), Number(ds.qty), ds.name, ds.rarity, Number(ds.vendorPrice));
      // No-arg actions
      fn(ds, el, e);
    });

    // Keep window.xxx for any remaining inline handlers during migration

    init();
  