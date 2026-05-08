// =====================================================================
// LMS Quick - content.js  v1.7
// 修正箇所:
//   1. XSS対策: HTMLに埋め込む文字列を全てescapeHtml()でサニタイズ
//   2. 課題マッチングを完全一致ベースに変更（誤マッチ防止）
//   3. 期限切れ課題を「期限切れ」セクションに分けて表示
//   4. tryAutoRegister: period を number型で統一、型バグ修正
//   5. パネルをヘッダー固定・コンテンツ差し替え方式に変更（フォーカス飛び防止）
//   6. [P1] URLなし授業のリンクをspanに変更（hrefリロード防止）
//   7. [P1] パネル外クリックで閉じる機能を追加
//   8. [P1] 日付パースをブラウザ非依存の関数に変更（Safari対策）
//   9. [新機能] 授業一覧ページから時間割を一括登録する機能を追加
//  10. [新機能] 課題アラートタブから全LMSを一括スキャンする機能を追加
//  11. [修正] 期限切れ課題の完了チェックが機能しない問題を修正
//  12. [修正] コース名変更時にdoneTasks키が孤立する問題を修正
//  13. [修正] renderAlerts のラベル条件・no-alert条件のバグを修正
//  14. [修正] デバッグ残骸コードを削除
// =====================================================================

const dayMap = {
    1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri',
    '月': 'mon', '火': 'tue', '水': 'wed', '木': 'thu', '金': 'fri'
};
const dayNames = { mon: '月曜日', tue: '火曜日', wed: '水曜日', thu: '木曜日', fri: '金曜日' };

let currentView = 'timetable';
let globalCurrentDayKey = 'mon';

// ── XSS対策: HTMLに埋め込む文字列をエスケープ ──
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── 他のページからの依頼を受けてfetchを代行するリスナー ──
// background.js から tabs.sendMessage で呼ばれる
// content.jsの隔離コンテキストで動くのでWebClassのセッション競合が起きない
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchForScan') {
        if (window.location.hostname !== 'lms-wc.el.kanazawa-u.ac.jp') {
            sendResponse({ ok: false, error: 'not on lms-wc' });
            return;
        }
        fetchDirect(request.url)
            .then(html => sendResponse({ ok: true, html }))
            .catch(err => sendResponse({ ok: false, error: err.message }));
        return true; // 非同期レスポンスのために必須
    }
});
function safeUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        if (u.protocol === 'https:' || u.protocol === 'http:') return url;
    } catch (_) { /* 相対URLや不正URLはそのまま返さない */ }
    return '';
}

// ── 日付パース: ブラウザ非依存（Safari対策） ──
// WebClassの "YYYY/MM/DD HH:MM" 形式はSafariで new Date() が NaN になるため正規化する
function parseDeadline(str) {
    if (!str) return new Date(NaN);
    // "YYYY/MM/DD HH:MM" → "YYYY-MM-DDTHH:MM" に変換
    return new Date(str.replace(/\//g, '-').replace(' ', 'T'));
}

// ── 期限日時を "M/D HH:MM" 形式にフォーマット ──
function formatDeadline(str) {
    const d = parseDeadline(str);
    if (isNaN(d)) return '';
    const month = d.getMonth() + 1;
    const day   = d.getDate();
    const hours = String(d.getHours()).padStart(2, '0');
    const mins  = String(d.getMinutes()).padStart(2, '0');
    return `${month}/${day} ${hours}:${mins}`;
}

// ── 課題の一意キー（完了チェックの識別に使う） ──
function taskKey(task) {
    return `${task.course}||${task.title}||${task.deadline}`;
}

// ── background.js 経由でfetch（CORSを回避） ──
function fetchViaBackground(url) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'fetchHtml', url }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.ok) {
                resolve(response.html);
            } else {
                reject(new Error(response?.error || 'fetch failed'));
            }
        });
    });
}

// ── 直接fetch（content.jsのページコンテキストで実行 = ブラウザのCookieを使う） ──
// lms-wcページ上でのみ使用する（同一オリジン + 正しいCookieが必要なため）
async function fetchDirect(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
}

// ── スキャン用fetch（どのページからでも動作） ──
// 優先順位:
//   1. lms-wcページならdirectFetch（同一オリジン）
//   2. background.jsから直接fetch（service workerのCookieが使えれば動く）
//   3. lms-wcタブのcontent.jsに依頼（tabs.sendMessage経由）
async function fetchForScan(url) {
    // lms-wcページなら直接fetch
    if (window.location.hostname === 'lms-wc.el.kanazawa-u.ac.jp') {
        return await fetchDirect(url);
    }

    // まずbackground.jsから直接fetchを試みる（WebClassタブ不要）
    try {
        const html = await fetchViaBackground(url);
        // ログイン画面へのリダイレクトが返った場合はCookieなしとみなす
        if (html.includes('/webclass/login.php') && !html.includes('course.php')) {
            throw new Error('NO_COOKIE');
        }
        return html;
    } catch (e) {
        if (e.message === 'NO_LMS_TAB') throw e; // tabs.sendMessageのエラーは再throw
        // background.jsが失敗 or Cookieなし → tabs.sendMessage にフォールバック
    }

    // フォールバック: lms-wcタブのcontent.jsに依頼
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'fetchInTab', url }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else if (response?.ok) {
                resolve(response.html);
            } else if (response?.error === 'NO_LMS_TAB') {
                reject(new Error('NO_LMS_TAB'));
            } else {
                reject(new Error(response?.error || 'fetch failed'));
            }
        });
    });
}

chrome.storage.local.get(['timetableData', 'lmsTasks', 'doneTasks', 'theme'], (result) => {
    let timetableData = result.timetableData || { mon: {}, tue: {}, wed: {}, thu: {}, fri: {} };
    let allTasksDict = result.lmsTasks || {};
    let doneTasks = result.doneTasks || {};
    let theme = result.theme || 'dark';

    // ── 起動ボタン ──
    const button = document.createElement('button');
    button.id = 'lms-timetable-btn';
    button.textContent = '時間割';
    // 通知ドット（課題あり時に表示）
    const notifDot = document.createElement('span');
    notifDot.id = 'lms-notif-dot';
    button.appendChild(notifDot);
    document.body.appendChild(button);

    // ── パネル本体（ヘッダー固定 + コンテンツエリア分離） ──
    const panel = document.createElement('div');
    panel.id = 'lms-timetable-panel';
    panel.className = 'lms-panel';
    if (theme === 'light') panel.classList.add('light-theme');

    // ヘッダー（一度だけ生成し、以後は差し替えない）
    const panelHeader = document.createElement('div');
    panelHeader.className = 'panel-header';
    panelHeader.innerHTML = `
        <span class="panel-logo">LMS Quick</span>
        <div class="header-nav">
          <button class="nav-btn" id="nav-timetable" title="時間割">🗓</button>
          <button class="nav-btn" id="nav-alert" title="課題アラート">🔔</button>
          <button class="nav-btn" id="nav-options" title="設定">⚙️</button>
        </div>`;

    // コンテンツエリア（ここだけ差し替える）
    const panelContent = document.createElement('div');
    panelContent.id = 'lms-panel-content';
    panelContent.className = 'lms-scroll-area';

    panel.appendChild(panelHeader);
    panel.appendChild(panelContent);
    document.body.appendChild(panel);

    button.addEventListener('click', () => panel.classList.toggle('show'));

    // パネル外クリックで閉じる（captureフェーズで検知: LMSページのstopPropagation対策）
    document.addEventListener('click', (e) => {
        if (
            panel.classList.contains('show') &&
            !panel.contains(e.target) &&
            !button.contains(e.target)
        ) {
            panel.classList.remove('show');
        }
    }, true); // true = captureフェーズ

    // ── 通知ドットを更新 ──
    function updateNotifDot() {
        const dot = document.getElementById('lms-notif-dot');
        if (!dot) return;
        const { active } = getUpdatedTasks();
        const undone = active.filter(a => !doneTasks[taskKey(a)]);
        const hasUrgent = undone.some(a => a.hoursLeft <= 24);
        if (undone.length === 0) {
            dot.className = '';
        } else {
            dot.className = hasUrgent ? 'dot-urgent' : 'dot-warning';
        }
    }

    // ── ナビゲーションのアクティブ状態を更新 ──
    function updateNavActive(activeTab) {
        panelHeader.querySelector('#nav-timetable').classList.toggle('active', activeTab === 'timetable');
        panelHeader.querySelector('#nav-alert').classList.toggle('active', activeTab === 'alert');
    }

    // ヘッダーのナビイベント（一度だけ登録）
    panelHeader.querySelector('#nav-timetable').addEventListener('click', () => switchView('timetable'));
    panelHeader.querySelector('#nav-alert').addEventListener('click', () => switchView('alert'));
    panelHeader.querySelector('#nav-options').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "openOptionsPage" });
    });

    // ── テーマ変更をリアルタイム反映 ──
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.theme) {
            if (changes.theme.newValue === 'light') panel.classList.add('light-theme');
            else panel.classList.remove('light-theme');
        }
        // lmsTasksが更新されたら（別タブでスキャン完了時）再読み込み
        if (namespace === 'local' && changes.lmsTasks) {
            allTasksDict = changes.lmsTasks.newValue || {};
            switchView(currentView);
            updateNotifDot();
        }
        if (namespace === 'local' && changes.doneTasks) {
            doneTasks = changes.doneTasks.newValue || {};
            if (currentView === 'alert') renderAlerts();
            updateNotifDot();
        }
        if (namespace === 'local' && changes.timetableData) {
            timetableData = changes.timetableData.newValue || { mon: {}, tue: {}, wed: {}, thu: {}, fri: {} };
            if (currentView === 'timetable') renderTimetable(globalCurrentDayKey);
        }
    });

    // ── 課題一覧取得（期限切れも含む） ──
    // 戻り値: { active: [...], expired: [...] }
    // active  = 168時間（1週間）以内かつ期限未切れ
    // expired = 24時間以内に期限切れ（今日中に気づける範囲）
    function getUpdatedTasks() {
        const now = new Date();
        const active = [];
        const expired = [];

        for (const courseName in allTasksDict) {
            allTasksDict[courseName].forEach(task => {
                const deadlineDate = parseDeadline(task.deadline);
                const diffMs = deadlineDate - now;
                const hoursLeft = Math.floor(diffMs / (1000 * 60 * 60));

                if (hoursLeft >= 0 && hoursLeft <= 168) {
                    active.push({ ...task, hoursLeft });
                } else if (hoursLeft < 0 && hoursLeft >= -24) {
                    // 24時間以内に期限切れ → 見逃しに気づけるよう表示
                    expired.push({ ...task, hoursLeft });
                }
            });
        }
        return { active, expired };
    }

    // ── 課題と授業名を紐付け（完全一致 or 包含の両方向、長い方優先） ──
    function findTasksForCourse(courseTitle) {
        const normalizedTitle = courseTitle.trim();
        let bestMatch = null;
        let bestMatchLen = 0;

        for (const courseName in allTasksDict) {
            const normalizedName = courseName.trim();
            const isMatch = normalizedTitle === normalizedName ||
                            normalizedTitle.includes(normalizedName) ||
                            normalizedName.includes(normalizedTitle);
            if (isMatch && normalizedName.length > bestMatchLen) {
                bestMatch = courseName;
                bestMatchLen = normalizedName.length;
            }
        }
        if (!bestMatch) return { taskType: 'none', taskCount: 0 };

        const now = new Date();
        const tasks = allTasksDict[bestMatch];
        const activeTasks = tasks.filter(t => {
            // 完了済みはバッジに表示しない
            if (doneTasks[taskKey(t)]) return false;
            const h = (parseDeadline(t.deadline) - now) / (1000 * 60 * 60);
            return h >= 0 && h <= 168;
        });
        if (activeTasks.length === 0) return { taskType: 'none', taskCount: 0 };

        const hasUrgent = activeTasks.some(t => (parseDeadline(t.deadline) - now) / (1000 * 60 * 60) <= 24);
        return { taskType: hasUrgent ? 'urgent' : 'normal', taskCount: activeTasks.length };
    }

    // ── 授業名から timetableData のLMS URLを逆引きする ──
    // 課題カードのリンクに使う。course.phpのURLはセッション依存で開けないため、
    // 設定画面で登録済みのSSO経由URL（singlesignon.php?group_id=...）を優先する。
    function findLmsUrlForCourse(courseNameFromTask) {
        const normalized = courseNameFromTask.trim();
        let bestUrl = '';
        let bestMatchLen = 0;

        for (const dayKey of ['mon', 'tue', 'wed', 'thu', 'fri']) {
            const dayData = timetableData[dayKey] || {};
            for (const period of Object.keys(dayData)) {
                const cls = dayData[period];
                if (!cls || !cls.title || !cls.url) continue;
                const clsTitle = cls.title.trim();
                const isMatch = normalized === clsTitle ||
                                normalized.includes(clsTitle) ||
                                clsTitle.includes(normalized);
                if (isMatch && clsTitle.length > bestMatchLen) {
                    bestUrl = cls.url;
                    bestMatchLen = clsTitle.length;
                }
            }
        }
        return bestUrl; // 見つからなければ空文字
    }

    // ── 時間割タブ描画 ──
    function renderTimetable(dayKey) {
        globalCurrentDayKey = dayKey;
        updateNavActive('timetable');
        const data = timetableData[dayKey] || {};
        const isKyomuSystem = window.location.hostname === 'eduweb.sta.kanazawa-u.ac.jp';
        const { active: allActive } = getUpdatedTasks();

        // 完了済みを除いたアクティブ課題のみバナーに表示
        const activeTasks = allActive.filter(a => !doneTasks[taskKey(a)]);
        const urgentCount = activeTasks.filter(a => a.hoursLeft <= 24).length;

        let html = '';

        // バナー
        if (activeTasks.length > 0) {
            const isUrgent = urgentCount > 0;
            html += `
            <div id="lms-top-banner">
                <div class="banner-inner ${isUrgent ? 'urgent' : 'warning'}">
                    <span class="banner-icon">${isUrgent ? '🔴' : '⚠️'}</span>
                    <div class="banner-text">
                        <div class="banner-label">${isUrgent ? '緊急 — 24時間以内' : '注意 — 1週間以内'}</div>
                        <div class="banner-desc">未提出の課題が ${escapeHtml(String(activeTasks.length))} 件あります</div>
                    </div>
                    <button class="banner-btn" id="btn-banner-alert">確認 →</button>
                </div>
            </div>`;
        }

        html += `
        <div class="day-header">
            <span class="day-name">${escapeHtml(dayNames[dayKey])}</span>
            <select id="day-select">
                <option value="mon" ${dayKey === 'mon' ? 'selected' : ''}>月曜日</option>
                <option value="tue" ${dayKey === 'tue' ? 'selected' : ''}>火曜日</option>
                <option value="wed" ${dayKey === 'wed' ? 'selected' : ''}>水曜日</option>
                <option value="thu" ${dayKey === 'thu' ? 'selected' : ''}>木曜日</option>
                <option value="fri" ${dayKey === 'fri' ? 'selected' : ''}>金曜日</option>
            </select>
        </div>`;

        const isRegistList = window.location.href.includes('RegistList.aspx');
        if (isKyomuSystem) {
            html += `<button id="bulk-reg-btn" ${!isRegistList ? 'disabled title="履修時間割表ページで使用できます"' : ''}><span class="auto-reg-text">時間割を一括登録</span></button>`;
        }

        html += `<div class="timetable-list">`;
        for (let i = 1; i <= 6; i++) {
            const cls = data[i];
            if (cls && cls.title) {
                const { taskType, taskCount } = findTasksForCourse(cls.title);
                const badgeHtml = taskType === 'urgent'
                    ? `<span class="task-badge urgent">🔴 締切近</span>`
                    : taskType === 'normal'
                        ? `<span class="task-badge normal">📌 ${escapeHtml(String(taskCount))}件</span>`
                        : '';
                const url = safeUrl(cls.url);
                // URLがない場合は <a> を生成しない（href="" によるページリロード防止）
                const linkOrSpan = url
                    ? `<a href="${escapeHtml(url)}" target="_blank" class="course-link">${escapeHtml(cls.title)}</a>`
                    : `<span class="course-link" style="cursor:default">${escapeHtml(cls.title)}</span>`;
                html += `<div class="timetable-item">
                    <span class="period-badge">${i}</span>
                    ${linkOrSpan}
                    ${badgeHtml}
                </div>`;
            } else {
                html += `<div class="timetable-item empty">
                    <span class="period-badge">${i}</span>
                    <span class="course-name">— 空き時間 —</span>
                </div>`;
            }
            if (i === 2) {
                html += `<div class="list-sep">
                    <div class="list-sep-line"></div>
                    <span class="list-sep-label">— 昼休み —</span>
                    <div class="list-sep-line"></div>
                </div>`;
            }
        }
        html += `</div>`;

        panelContent.innerHTML = html;

        // イベント再アタッチ
        document.getElementById('day-select').addEventListener('change', (e) => renderTimetable(e.target.value));
        const bulkBtn = document.getElementById('bulk-reg-btn');
        if (bulkBtn) bulkBtn.addEventListener('click', tryBulkRegister);
        const bannerBtn = document.getElementById('btn-banner-alert');
        if (bannerBtn) bannerBtn.addEventListener('click', () => switchView('alert'));
    }

    // ── アラートタブ描画 ──
    function renderAlerts() {
        updateNavActive('alert');
        const { active: allActive, expired: expiredTasks } = getUpdatedTasks();
        allActive.sort((a, b) => a.hoursLeft - b.hoursLeft);

        // 完了済みとそれ以外に分離
        const activeTasks     = allActive.filter(a => !doneTasks[taskKey(a)]);
        const donedActive     = allActive.filter(a =>  doneTasks[taskKey(a)]);
        const filteredExpired = expiredTasks.filter(a => !doneTasks[taskKey(a)]);
        const donedExpired    = expiredTasks.filter(a =>  doneTasks[taskKey(a)]);

        // カードHTML生成ヘルパー
        function cardHtml(a, type) {
            const key = escapeHtml(taskKey(a));
            const url = safeUrl(findLmsUrlForCourse(a.course) || a.url);

            // 完了済みカード（コンパクト表示）
            if (type === 'done') {
                return `
                <div class="alert-card done-card">
                    <button class="check-btn checked" data-key="${key}" title="完了を取り消す">✓</button>
                    <div class="done-inner">
                        <div class="card-course">${escapeHtml(a.course)}</div>
                        <div class="card-title done-title">${escapeHtml(a.title)}</div>
                        <div class="card-deadline" style="margin-top:3px">締切 ${escapeHtml(formatDeadline(a.deadline))}</div>
                    </div>
                </div>`;
            }

            // 通常・期限切れカード
            const u = type === 'expired' ? 'expired' : (a.hoursLeft <= 24 ? 'urgent' : 'warning');
            const progressPct = type !== 'expired'
                ? Math.round((Math.max(0, Math.min(a.hoursLeft, 168)) / 168) * 100)
                : null;
            const timeDisplay = type === 'expired'
                ? `<span class="time-num expired-num">${Math.abs(a.hoursLeft)}</span><span class="time-unit">時間前</span>`
                : `<span class="time-num">${a.hoursLeft < 1 ? '&lt; 1' : a.hoursLeft}</span><span class="time-unit">時間後</span>`;
            const badgeHtml = type === 'expired'
                ? `<div class="badge expired-badge">期限切れ</div>`
                : `<div class="badge">${u === 'urgent' ? '🔴緊急' : '⚠️注意'}</div>`;

            return `
            <div class="alert-card-wrap">
                <button class="check-btn" data-key="${key}" title="提出済みにする"></button>
                <a href="${escapeHtml(url)}" ${url ? 'target="_blank"' : ''}
                   class="alert-card ${u}" ${!url ? 'onclick="return false"' : ''}>
                    <div class="card-top">
                        ${badgeHtml}
                        <div class="type-label">${escapeHtml(a.type)}</div>
                    </div>
                    <div class="card-course">${escapeHtml(a.course)}</div>
                    <div class="card-title">${escapeHtml(a.title)}</div>
                    <div class="card-bottom">
                        <div class="card-deadline">締切 ${escapeHtml(formatDeadline(a.deadline))}</div>
                        <div class="time-display">${timeDisplay}</div>
                    </div>
                    ${progressPct !== null ? `<div class="progress-wrap"><div class="progress-bar" style="width:${progressPct}%"></div></div>` : ''}
                </a>
            </div>`;
        }

        const isLmsWc = window.location.hostname === 'lms-wc.el.kanazawa-u.ac.jp';

        let html = `<div class="alert-section-inner">`;
        html += `<button id="bulk-scan-btn"><span class="auto-reg-text">課題を一括スキャン</span></button>`;
        if (!isLmsWc) {
            html += `<div class="scan-hint">💡 WebClassのページをいずれか1つ開いた状態でスキャンしてください</div>`;
        }

        // 期限切れセクション（完了済みを除外）
        if (filteredExpired.length > 0) {
            filteredExpired.sort((a, b) => b.hoursLeft - a.hoursLeft);
            html += `<div class="alert-section-label expired-label">⚠️ 期限切れ（24時間以内）</div>`;
            filteredExpired.forEach(a => { html += cardHtml(a, 'expired'); });
        }

        // アクティブ課題セクション
        const allDoned = [...donedActive, ...donedExpired];
        html += `<div class="alert-section-label">${filteredExpired.length > 0 ? '⏰ 期限が近い課題' : '期限が近い課題'}</div>`;
        if (activeTasks.length === 0 && allDoned.length === 0) {
            html += `<div class="no-alert">✅ 期限の迫った課題はありません</div>`;
        } else {
            activeTasks.forEach(a => { html += cardHtml(a, 'active'); });
        }

        // 完了済みセクション（アクティブ + 期限切れ両方）
        if (allDoned.length > 0) {
            html += `<div class="alert-section-label done-label">✓ 完了済み</div>`;
            allDoned.forEach(a => { html += cardHtml(a, 'done'); });
        }

        html += `</div>`;
        panelContent.innerHTML = html;
        panelContent.classList.add('alert-view');

        // 一括スキャンボタン
        const scanBtn = document.getElementById('bulk-scan-btn');
        if (scanBtn) scanBtn.addEventListener('click', tryBulkScan);

        // チェックボタンのイベント（完了トグル）
        panelContent.querySelectorAll('.check-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const key = btn.dataset.key;

                if (doneTasks[key]) {
                    // 完了済み → 取り消し（アニメーションなし）
                    delete doneTasks[key];
                    chrome.storage.local.set({ doneTasks }, () => renderAlerts());
                } else {
                    // 未完了 → 完了（アニメーションを挟む）
                    const wrap = btn.closest('.alert-card-wrap');
                    if (wrap) {
                        wrap.classList.add('completing');
                        setTimeout(() => {
                            doneTasks[key] = true;
                            chrome.storage.local.set({ doneTasks }, () => renderAlerts());
                        }, 550); // CSSアニメーションと同じ時間
                    } else {
                        doneTasks[key] = true;
                        chrome.storage.local.set({ doneTasks }, () => renderAlerts());
                    }
                }
            });
        });
    }

    function switchView(viewName) {
        currentView = viewName;
        panelContent.scrollTop = 0;
        panelContent.classList.remove('alert-view');
        if (viewName === 'timetable') renderTimetable(globalCurrentDayKey);
        else renderAlerts();
        updateNotifDot();
    }

    // ── 課題一括スキャン ──
    // 処理の流れ:
    //   1. timetableData から登録済みの全LMS URLを収集
    //   2. 各URLを fetch() でバックグラウンド取得（タブを開かない）
    //   3. course.php と同じセレクターで課題を抽出
    //   4. 既存データにマージ（上書きではなく追記）
    //   5. 期限切れから2週間超の古い課題を自動削除
    async function tryBulkScan() {
        const scanBtn = document.getElementById('bulk-scan-btn');
        if (!scanBtn) return;


        // ── ステップ1: 登録済みURLを収集 ──
        const targets = [];
        for (const dayKey of ['mon', 'tue', 'wed', 'thu', 'fri']) {
            const dayData = timetableData[dayKey] || {};
            for (const period of Object.keys(dayData)) {
                const cls = dayData[period];
                if (!cls || !cls.title || !cls.url) continue;
                if (!targets.find(t => t.url === cls.url)) {
                    targets.push({ courseName: cls.title, url: cls.url });
                }
            }
        }


        if (targets.length === 0) {
            alert('登録済みのLMS URLがありません。\nまず時間割にLMSのURLを登録してください。');
            return;
        }

        // ── ステップ2: UIを「スキャン中」に変更 ──
        scanBtn.disabled = true;
        scanBtn.querySelector('.auto-reg-text').textContent = `⏳ スキャン中… 0/${targets.length}`;

        // ── ステップ3: 各LMSページをfetchして課題を抽出 ──
        const freshTasks = {};
        let doneCount = 0;
        let failCount = 0;

        for (const target of targets) {
            try {
                // courseIdを抽出
                let courseId = null;
                const acanthusMatch = target.url.match(/[?&]courseId=([^&]+)/);
                const lmsMatch      = target.url.match(/[?&]group_id=([^&]+)/);
                const coursePhpMatch = target.url.match(/\/webclass\/course\.php\/([^/?]+)/);
                if (acanthusMatch)  courseId = acanthusMatch[1];
                else if (lmsMatch)  courseId = lmsMatch[1];
                else if (coursePhpMatch) courseId = coursePhpMatch[1];

                if (!courseId) {
                    throw new Error('courseId not found');
                }

                // acanthusをスキップし、lms-wcのlogin.phpから直接認証フローを開始
                // （lms-wcページ上でのfetchなのでShibbolethセッションCookieが送られる）
                const loginUrl = `https://lms-wc.el.kanazawa-u.ac.jp/webclass/login.php?group_id=${courseId}&auth_mode=SHIB`;

                let html, parser, doc;
                try {
                    html = await fetchForScan(loginUrl);
                } catch (e) {
                    if (e.message === 'NO_LMS_TAB') {
                        scanBtn.disabled = false;
                        scanBtn.querySelector('.auto-reg-text').textContent = '課題を一括スキャン';
                        alert('WebClassのタブが見つかりませんでした。\nWebClassをいずれか1つ開いてから再度スキャンしてください。');
                        return;
                    }
                    throw e;
                }
                parser = new DOMParser();
                doc = parser.parseFromString(html, 'text/html');

                // Step1: login.php → course.php/{id}/login?acs_=...（バックスラッシュエスケープ対応）
                const step1Match = html.match(/window\.location\.href\s*=\s*"((?:\\\/|[^"])+course\.php(?:\\\/|[^"])+)"/);
                if (step1Match) {
                    const rawPath = step1Match[1].replace(/\\\//g, '/');
                    const step1Url = rawPath.startsWith('http')
                        ? rawPath
                        : 'https://lms-wc.el.kanazawa-u.ac.jp' + rawPath;
                    html = await fetchForScan(step1Url);
                    parser = new DOMParser();
                    doc = parser.parseFromString(html, 'text/html');
                }

                // Step2: course.php/{id}/login?acs_= → course.php/{id}/?acs_=...
                const step2Match = html.match(/window\.location\.href\s*=\s*"(\/webclass\/course\.php\/[^"]+\?acs_=[^"]+)"/);
                if (step2Match) {
                    const step2Url = 'https://lms-wc.el.kanazawa-u.ac.jp' + step2Match[1];
                    html = await fetchForScan(step2Url);
                    parser = new DOMParser();
                    doc = parser.parseFromString(html, 'text/html');
                }

                const itemCount = doc.querySelectorAll('.cl-contentsList_listGroupItem').length;

                const assignments = [];
                doc.querySelectorAll('.cl-contentsList_listGroupItem').forEach(item => {
                    const titleEl    = item.querySelector('.cm-contentsList_contentName');
                    const categoryEl = item.querySelector('.cl-contentsList_categoryLabel');
                    if (!titleEl || !categoryEl) return;

                    const categoryText = categoryEl.textContent.trim();
                    if (!['レポート', 'アンケート', '試験', 'テスト'].some(t => categoryText.includes(t))) return;

                    let deadlineStr = null;
                    item.querySelectorAll('.cm-contentsList_contentDetailListItem').forEach(detail => {
                        if (detail.textContent.includes('利用可能期間')) {
                            const dataEl = detail.querySelector('.cm-contentsList_contentDetailListItemData');
                            if (dataEl) {
                                const parts = dataEl.textContent.trim().split(' - ');
                                deadlineStr = parts.length > 1 ? parts[1].trim() : parts[0].trim();
                            }
                        }
                    });

                    if (deadlineStr) {
                        assignments.push({
                            course:   target.courseName,
                            title:    titleEl.textContent.replace('New', '').trim(),
                            type:     categoryText,
                            deadline: deadlineStr,
                            url:      target.url
                        });
                    }
                });

                freshTasks[target.courseName] = assignments;

            } catch (e) {
                // エラー内容をコンソールに出力
                failCount++;
            }

            doneCount++;
            const textEl = scanBtn.querySelector('.auto-reg-text');
            if (textEl) textEl.textContent = `⏳ スキャン中… ${doneCount}/${targets.length}`;
        }

        // ── ステップ4: 既存データにマージ ──
        const merged = { ...allTasksDict };
        for (const [courseName, tasks] of Object.entries(freshTasks)) {
            merged[courseName] = tasks; // 取得できた授業は最新データで上書き
        }

        // ── ステップ5: 期限切れ2週間超の課題を自動削除 ──
        const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        for (const courseName of Object.keys(merged)) {
            merged[courseName] = merged[courseName].filter(task => {
                const d = parseDeadline(task.deadline);
                return isNaN(d) || d >= twoWeeksAgo; // パース失敗のものは残す
            });
            // 課題が0件になった授業はキーごと削除
            if (merged[courseName].length === 0) delete merged[courseName];
        }

        // ── ステップ6: 保存して表示更新 ──
        await new Promise(resolve => chrome.storage.local.set({ lmsTasks: merged }, resolve));
        allTasksDict = merged;

        const successCount = targets.length - failCount;
        const msg = failCount > 0
            ? `スキャン完了: ${successCount}件\n（${failCount}件は取得できませんでした）`
            : `スキャン完了: ${successCount}件の授業をスキャンしました`;
        alert(msg);

        scanBtn.disabled = false;
        scanBtn.querySelector('.auto-reg-text').textContent = '課題を一括スキャン';
        renderAlerts();
    }

    // ── 時間割一括登録（授業一覧ページ用） ──
    // 処理の流れ:
    //   1. 授業一覧ページのDOMから授業名・曜日・時限・ActingList URLを収集
    //   2. 各授業ページを fetch() でバックグラウンド取得（タブを開かない）
    //   3. target="webclass" のリンクからLMS URLを抽出
    //   4. 全授業分まとめて chrome.storage に保存
    async function tryBulkRegister() {
        const bulkBtn = document.getElementById('bulk-reg-btn');
        if (!bulkBtn) return;

        // ── ステップ1: 授業一覧ページから授業情報を収集 ──
        // IDパターン: ctl00_phContents_rrMain_ttTable_lct{曜日}{時限}_ctl00_lblStaffName
        // 曜日: Mon/Tue/Wed/Thu/Fri、時限: 1〜6
        const dayKeyMap = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri' };
        const dayJaMap  = { Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金' };
        const courses = [];

        for (const [dayEn, dayKey] of Object.entries(dayKeyMap)) {
            for (let period = 1; period <= 6; period++) {
                const cellId = `ctl00_phContents_rrMain_ttTable_lct${dayEn}${period}_ctl00_lblStaffName`;
                const cell = document.getElementById(cellId);
                if (!cell) continue;

                const linkEl = cell.querySelector('a[href*="ActingList.aspx"]');
                if (!linkEl) continue;

                // 授業名は "<授業名>\n(教員名)" の形式なので1行目だけ取る
                const rawText = linkEl.innerText.trim();
                const courseName = rawText.split('\n')[0].replace(/\[.*?\]/g, '').trim();
                if (!courseName) continue;

                const actingUrl = linkEl.href;
                courses.push({ courseName, actingUrl, dayKey, period });
            }
        }

        if (courses.length === 0) {
            alert('授業情報が見つかりませんでした。\n授業一覧（履修時間割表）ページで実行してください。');
            return;
        }

        // ── ステップ2: UIを「取得中」状態に変更 ──
        bulkBtn.disabled = true;
        bulkBtn.querySelector('.auto-reg-text').textContent = `⏳ 取得中… 0/${courses.length}`;

        // ── ステップ3: 各授業ページをfetchしてLMS URLを取得 ──
        const newTimetableData = { mon: {}, tue: {}, wed: {}, thu: {}, fri: {} };
        let doneCount = 0;
        let failCount = 0;

        // 一度に大量リクエストを送らないよう順番に処理する
        for (const course of courses) {
            try {
                const html = await fetchViaBackground(course.actingUrl);

                // DOMParserでHTMLを解析してLMSリンクを探す
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const lmsLinkEl = doc.querySelector('a[target="webclass"]');
                const lmsUrl = lmsLinkEl ? lmsLinkEl.href : '';

                if (!newTimetableData[course.dayKey][course.period]) {
                    newTimetableData[course.dayKey][course.period] = {
                        title: course.courseName,
                        url:   safeUrl(lmsUrl)
                    };
                }
            } catch (e) {
                // fetch失敗でも他の授業の登録は続ける
                failCount++;
                if (!newTimetableData[course.dayKey][course.period]) {
                    newTimetableData[course.dayKey][course.period] = {
                        title: course.courseName,
                        url:   ''
                    };
                }
            }

            doneCount++;
            if (bulkBtn.querySelector('.auto-reg-text')) {
                bulkBtn.querySelector('.auto-reg-text').textContent =
                    `⏳ 取得中… ${doneCount}/${courses.length}`;
            }
        }

        // ── ステップ4: chrome.storage に保存 ──
        await new Promise(resolve => chrome.storage.local.set({ timetableData: newTimetableData }, resolve));
        timetableData = newTimetableData;

        // ── 完了メッセージ ──
        const successCount = courses.length - failCount;
        const msg = failCount > 0
            ? `登録完了: ${successCount}件\n（${failCount}件はLMS URLの取得に失敗しました。手動で設定画面から入力できます）`
            : `登録完了: ${successCount}件の授業を登録しました！`;
        alert(msg);

        bulkBtn.disabled = false;
        bulkBtn.querySelector('.auto-reg-text').textContent = '⬇ 時間割を一括登録';
        renderTimetable(globalCurrentDayKey);
    }

    // ── 教務システム自動登録（個別ページ用） ──
    function tryAutoRegister() {
        const nameElem = document.getElementById('ctl00_phContents_ucActingList_lblLctName');
        const dayElem  = document.getElementById('ctl00_phContents_ucActingList_lblDay');
        const lmsLinkElem = document.querySelector('a[target="webclass"]');

        if (!nameElem || !dayElem || !lmsLinkElem) {
            alert('自動登録に必要な情報が見つかりませんでした。\n授業詳細ページを開いてから再度お試しください。');
            return;
        }

        const rawName    = nameElem.innerText.split('\n')[0].trim();
        const rawDayTime = dayElem.innerText.trim();
        const lmsUrl     = lmsLinkElem.href;
        const dayKey     = dayMap[rawDayTime.charAt(0)];

        if (!dayKey) {
            alert('曜日情報を読み取れませんでした。');
            return;
        }

        // period は必ず number 型で扱う
        const periods = [];
        const timePart = rawDayTime.substring(1);
        if (timePart.includes('〜')) {
            const range = timePart.split('〜');
            const from  = parseInt(range[0], 10);
            const to    = parseInt(range[1], 10);
            for (let i = from; i <= to; i++) {
                if (i >= 1 && i <= 6) periods.push(i);
            }
        } else {
            const p = parseInt(timePart, 10);
            if (p >= 1 && p <= 6) periods.push(p);
        }

        if (periods.length === 0) {
            alert('時限情報を読み取れませんでした。');
            return;
        }

        periods.forEach(p => {
            timetableData[dayKey][p] = { title: rawName, url: lmsUrl };
        });

        chrome.storage.local.set({ timetableData }, () => {
            alert(`登録完了: ${rawName}\n${dayNames[dayKey]} ${periods.join('・')}限`);
            renderTimetable(dayKey);
        });
    }

    // ── 初期表示 ──
    const today = new Date().getDay();
    globalCurrentDayKey = (today === 0 || today === 6) ? 'mon' : (dayMap[today] || 'mon');
    switchView('timetable');
    updateNotifDot();
});

// =====================================================================
// 課題スキャン（LMSの course.php で自動実行）
// =====================================================================
function scanAndSaveAssignments() {
    const rawCourseName = document.title.split(' - ')[0].trim();
    const courseUrl     = window.location.href;
    const assignments   = [];

    const items = document.querySelectorAll('.cl-contentsList_listGroupItem');
    items.forEach(item => {
        const titleEl    = item.querySelector('.cm-contentsList_contentName');
        const categoryEl = item.querySelector('.cl-contentsList_categoryLabel');
        if (!titleEl || !categoryEl) return;

        const categoryText = categoryEl.innerText.trim();
        if (!['レポート', 'アンケート', '試験', 'テスト'].some(t => categoryText.includes(t))) return;

        let deadlineStr = null;
        item.querySelectorAll('.cm-contentsList_contentDetailListItem').forEach(detail => {
            if (detail.innerText.includes('利用可能期間')) {
                const dataEl = detail.querySelector('.cm-contentsList_contentDetailListItemData');
                if (dataEl) {
                    const parts = dataEl.innerText.trim().split(' - ');
                    deadlineStr = parts.length > 1 ? parts[1].trim() : parts[0].trim();
                }
            }
        });

        if (deadlineStr) {
            assignments.push({
                course:   rawCourseName, // 後でtimetableDataと照合して上書きする
                title:    titleEl.innerText.replace('New', '').trim(),
                type:     categoryText,
                deadline: deadlineStr,
                url:      courseUrl
            });
        }
    });

    // timetableData の授業名と照合して一致するものがあればそちらを優先する
    chrome.storage.local.get(['lmsTasks', 'timetableData', 'doneTasks'], (result) => {
        const allTasks  = result.lmsTasks  || {};
        const timetable = result.timetableData || {};
        const doneTasksData = result.doneTasks || {};

        // timetableDataの全授業名から部分一致で最長マッチを探す
        let matchedName = rawCourseName;
        let bestMatchLen = 0;
        for (const dayKey of ['mon', 'tue', 'wed', 'thu', 'fri']) {
            const dayData = timetable[dayKey] || {};
            for (const period of Object.keys(dayData)) {
                const cls = dayData[period];
                if (!cls || !cls.title) continue;
                const clsTitle = cls.title.trim();
                const isMatch = rawCourseName.includes(clsTitle) || clsTitle.includes(rawCourseName);
                if (isMatch && clsTitle.length > bestMatchLen) {
                    matchedName  = clsTitle;
                    bestMatchLen = clsTitle.length;
                }
            }
        }

        // 授業名を統一してから保存（古い重複キーがあれば削除）
        if (matchedName !== rawCourseName && allTasks[rawCourseName]) {
            delete allTasks[rawCourseName];
        }
        const finalAssignments = assignments.map(a => ({ ...a, course: matchedName }));
        allTasks[matchedName] = finalAssignments;

        // doneTasks のキーも旧授業名 → 新授業名に更新する
        // （コース名が変わるとチェックが外れる問題を防ぐ）
        let doneTasksChanged = false;
        const updatedDoneTasks = { ...doneTasksData };
        for (const key of Object.keys(doneTasksData)) {
            if (key.startsWith(rawCourseName + '||') && matchedName !== rawCourseName) {
                const newKey = matchedName + '||' + key.slice(rawCourseName.length + 2);
                updatedDoneTasks[newKey] = true;
                delete updatedDoneTasks[key];
                doneTasksChanged = true;
            }
        }

        const saveData = { lmsTasks: allTasks };
        if (doneTasksChanged) saveData.doneTasks = updatedDoneTasks;
        chrome.storage.local.set(saveData);
    });
}

window.addEventListener('load', () => {
    if (window.location.href.includes('course.php')) {
        setTimeout(scanAndSaveAssignments, 1500);
    }
});