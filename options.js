// =====================================================================
// LMS Quick - options.js  v1.1
// 修正箇所:
//   1. リセット処理: timetableData・lmsTasks 両方を削除
//   2. グリッド初期化ガード: data属性ベースの確実な判定に変更
//   3. 保存成功時のフィードバックを改善
// =====================================================================

document.addEventListener('DOMContentLoaded', () => {
    const days    = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const periods = [1, 2, 3, 4, 5, 6];

    const grid = document.getElementById('timetable-grid');

    // ── グリッド生成（二重生成を data属性で確実に防ぐ） ──
    if (grid && !grid.dataset.initialized) {
        grid.dataset.initialized = 'true';

        for (let i = 1; i <= 6; i++) {
            grid.insertAdjacentHTML('beforeend', `
                <div class="period-label" style="grid-column:1; grid-row:${i + 1};">
                    <span class="period-num">${i}</span>
                    <span class="period-ji">限</span>
                </div>`);

            days.forEach((day, index) => {
                grid.insertAdjacentHTML('beforeend', `
                    <div class="cell col-${day}" style="grid-column:${index + 2}; grid-row:${i + 1};">
                        <div class="field">
                            <label>授業名</label>
                            <input type="text" id="${day}-${i}-title" placeholder="授業名">
                        </div>
                        <div class="field">
                            <label>URL</label>
                            <input type="url" id="${day}-${i}-url" class="url-input" placeholder="https://...">
                        </div>
                    </div>`);
            });
        }
    }

    // ── 保存データの読み込み ──
    chrome.storage.local.get(['timetableData', 'theme'], (result) => {
        const data = result.timetableData;
        if (data) {
            days.forEach(day => {
                periods.forEach(period => {
                    const titleInput = document.getElementById(`${day}-${period}-title`);
                    const urlInput   = document.getElementById(`${day}-${period}-url`);
                    if (titleInput && data[day]?.[period]) titleInput.value = data[day][period].title || '';
                    if (urlInput   && data[day]?.[period]) urlInput.value   = data[day][period].url   || '';
                });
            });
        }

        // テーマ設定を反映
        const savedTheme = result.theme || 'dark';
        const themeSelect = document.getElementById('theme-select');
        if (themeSelect) themeSelect.value = savedTheme;
        if (savedTheme === 'light') document.body.classList.add('light-theme');
        else document.body.classList.remove('light-theme');
    });

    // ── テーマ切り替え ──
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
        themeSelect.addEventListener('change', (e) => {
            const newTheme = e.target.value;
            chrome.storage.local.set({ theme: newTheme });
            if (newTheme === 'light') document.body.classList.add('light-theme');
            else document.body.classList.remove('light-theme');
        });
    }

    // ── 保存ボタン ──
    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const dataToSave = { mon: {}, tue: {}, wed: {}, thu: {}, fri: {} };
            days.forEach(day => {
                periods.forEach(period => {
                    const titleEl = document.getElementById(`${day}-${period}-title`);
                    const urlEl   = document.getElementById(`${day}-${period}-url`);
                    if (titleEl && urlEl) {
                        dataToSave[day][period] = {
                            title: titleEl.value.trim(),
                            url:   urlEl.value.trim()
                        };
                    }
                });
            });

            chrome.storage.local.set({ timetableData: dataToSave }, () => {
                const original = saveBtn.textContent;
                saveBtn.textContent = '✓ 保存しました';
                saveBtn.disabled = true;
                setTimeout(() => {
                    saveBtn.textContent = original;
                    saveBtn.disabled = false;
                }, 2000);
            });
        });
    }

    // ── リセットボタン（timetableData と lmsTasks の両方を削除） ──
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (confirm('全ての時間割データと課題データを削除してもよろしいですか？\nこの操作は取り消せません。')) {
                chrome.storage.local.remove(['timetableData', 'lmsTasks', 'doneTasks'], () => {
                    alert('データをリセットしました。');
                    window.location.reload();
                });
            }
        });
    }
});