/** 刷新后立即恢复导航/面板高亮，避免先闪错误 Tab */
(function () {
    const TAB_KEY = 'qb-up-limit-current-tab';
    const DEVICE_TYPE_KEY = 'qb-up-limit-device-type-filter';
    const LEGACY_PLATFORM_KEY = 'qb-up-limit-current-platform';
    const VALID_TABS = { devices: 1, stats: 1, events: 1, syslogs: 1 };

    function readHashTab() {
        const raw = String(location.hash || '').replace(/^#\/?/, '').trim();
        return VALID_TABS[raw] ? raw : '';
    }

    function readBootUiState() {
        try {
            let tab = readHashTab() || sessionStorage.getItem(TAB_KEY) || 'devices';
            if (!VALID_TABS[tab]) tab = 'devices';
            const legacyPlatform = sessionStorage.getItem(LEGACY_PLATFORM_KEY);
            if (legacyPlatform === 'emby') {
                sessionStorage.setItem(DEVICE_TYPE_KEY, 'emby');
            }
            return { tab };
        } catch (e) {
            return { tab: 'devices' };
        }
    }

    function applyBootNavUi(state) {
        document.querySelectorAll('.nav-tab[data-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === state.tab);
        });
    }

    function applyBootPanelUi(state) {
        document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
        const panel = document.getElementById(`tab-${state.tab}`);
        if (panel) panel.classList.add('active');
    }

    const state = readBootUiState();
    window.__bootUiState = state;

    window.applyBootNavigationUi = function applyBootNavigationUi() {
        applyBootNavUi(state);
        if (document.querySelector('.tab-panel')) {
            applyBootPanelUi(state);
            document.documentElement.classList.add('nav-booted');
        }
    };

    applyBootNavUi(state);
})();
