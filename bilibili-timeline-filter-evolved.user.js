// ==UserScript==
// @name         B站动态分组过滤
// @namespace    https://github.com/dust-iny/bilibili-dynamic-group-filter
// @version      1.1.2
// @description  可配置多个关注分组合并为自定义标签，支持 Bilibili Evolved 夜间模式
// @author       dust-iny
// @match        https://t.bilibili.com/*
// @grant        unsafeWindow
// @license      MIT
// @homepageURL  https://github.com/dust-iny/bilibili-dynamic-group-filter
// @source       https://github.com/dust-iny/bilibili-dynamic-group-filter
// @supportURL   https://github.com/dust-iny/bilibili-dynamic-group-filter/issues
// @icon         https://www.bilibili.com/favicon.ico
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';
    // --- 脚本配置 ---

    const GLOBAL_STATE = {
        isFiltering: false, // 是否开启过滤模式
        targetUids: [], // 当前选中的目标UID列表
        myUid: null,// 当前登录用户的UID
        consecutiveEmptyResponses:0//熔断计数器，当连续访问分页未命中次数过多时熔断
    };

    const API_CONFIG = {
        TAGS: 'https://api.bilibili.com/x/relation/tags', // 获取分组列表
        TAG_USERS: 'https://api.bilibili.com/x/relation/tag',// 获取分组下的成员
        FEED_API: 'polymer/web-dynamic/v1/feed/all'// 动态流API片段
    };

    const UI_CONFIG = {
        MAX_RETRY_PAGES: 10, // 过滤模式下，如果没有匹配内容，最大自动翻页数
        MAX_EMPTY_BATCHES: 3//最大连续空包数
    };

    // --- Fetch API劫持实现动态过滤 ---
    const originalFetch = unsafeWindow.fetch;
    //备份原fetch方法后劫持并重写
    unsafeWindow.fetch = async function(urlOrRequest, options) {//URL标准化，字符串则直接使用，request对象则取出url
        let urlString;
        if (typeof urlOrRequest === 'string') {
            urlString = urlOrRequest;
        } else if (urlOrRequest instanceof Request) {
            urlString = urlOrRequest.url;
        } else {
            urlString = String(urlOrRequest);
        }

        // 仅在开启过滤且请求为动态流时拦截
        if (GLOBAL_STATE.isFiltering && urlString.includes(API_CONFIG.FEED_API)) {
            return await fetchUntilFound(urlString, options, 1, new Set(GLOBAL_STATE.targetUids), selectionVersion);
        }

        if (urlString.includes(API_CONFIG.FEED_API) && (!options?.method || options.method.toUpperCase() === 'GET') && typeof urlOrRequest === 'string') {
            return fetchFeedCached(urlString, options);
        }
        return originalFetch(urlOrRequest, options);//当过滤未开启或不是动态流api时，调用原fetch方法
    };

    // Cache unfiltered responses, so each tab can filter the same recent page independently.
    const feedCache = new Map();
    async function fetchFeedCached(url, options) {
        if (options?.signal || (options?.method && options.method.toUpperCase() !== 'GET')) return originalFetch(url, options);
        const key = JSON.stringify([GLOBAL_STATE.myUid || '', url, options?.credentials || '', [...new Headers(options?.headers).entries()]]);
        const now = Date.now();
        let entry = feedCache.get(key);
        if (entry && now - entry.time < 15000) return (await entry.promise).clone();
        if (entry) feedCache.delete(key);
        entry = { time: now, promise: null };
        entry.promise = Promise.resolve(originalFetch(url, options)).then(async response => {
            if (!response.ok) { if (feedCache.get(key) === entry) feedCache.delete(key); return response; }
            // API-level failures must not be cached either.
            const data = await response.clone().json().catch(() => null);
            if (data?.code !== 0 || !Array.isArray(data?.data?.items)) {
                if (feedCache.get(key) === entry) feedCache.delete(key);
            }
            return response;
        }).catch(error => { if (feedCache.get(key) === entry) feedCache.delete(key); throw error; });
        feedCache.set(key, entry);
        while (feedCache.size > 24) feedCache.delete(feedCache.keys().next().value);
        return (await entry.promise).clone();
    }

    function constructNextUrl(currentUrlString, nextOffset) {//通过URL方法以base地址和当前url构建新的url，并替换offset达到读取下一页的效果
        try {
            const urlObj = new URL(currentUrlString, location.href);
            urlObj.searchParams.set('offset', nextOffset);
            return urlObj.toString();
        } catch (e) {
            return currentUrlString;
        }
    }

    async function fetchUntilFound(url, options, attempt, targetUids, version) {
        try {
            const response = await fetchFeedCached(url, options);
            if (!response.ok) return response;

            const clone = response.clone();//发起真实请求并clone非报错的response
            let data;
            try {
                data = await clone.json();//response中json解析错误
            } catch (jsonErr) {
                return response;
            }

            if (!data?.data?.items || !Array.isArray(data.data.items)) {//response中json不含有data.data.item或data.data.item不是数组
                return response;
            }

            if (version !== selectionVersion) {
                data.data.items = [];
                return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
            }

            // 通过filter(item->({}))方法过滤data.data.items中的动态，定义当前循环对象为item
            const filteredItems = data.data.items.filter(item => {
                const mid = item?.modules?.module_author?.mid;
                return targetUids.has(String(mid));//当targetUids包含遍历到的对象中的item.modules.module_author.mid，则该动态被滤出
            });

            const nextOffset = data.data.offset;
            const hasMore = data.data.has_more;

            if (filteredItems.length > 0) {// 当过滤后至少有一条，则说明命中了数据
                GLOBAL_STATE.consecutiveEmptyResponses = 0;//清空熔断计数器
                data.data.items = filteredItems;//重新把过滤后的数组包装成json作response传给前端渲染
                return new Response(JSON.stringify(data), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            }

            // 未命中且动态流显示还能往下、且未达到最大未命中阈值时，继续翻页
            if (hasMore && nextOffset && attempt <= UI_CONFIG.MAX_RETRY_PAGES) {
                const nextUrl = constructNextUrl(url, nextOffset);
                return await fetchUntilFound(nextUrl, options, attempt + 1, targetUids, version);
            }

            // 达到尝试上限，返回空数据并同步 offset
            GLOBAL_STATE.consecutiveEmptyResponses++;
            data.data.items = [];
            if (nextOffset) {
                data.data.offset = nextOffset;
            }
            if (GLOBAL_STATE.consecutiveEmptyResponses >= UI_CONFIG.MAX_EMPTY_BATCHES){
                data.data.has_more = false;//达到尝试上限的次数达到阈值，触发熔断，将has_more置为false避免再进行刷新
            }

            return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });

        } catch (e) {
            console.error('Fetch filter error:', e);
            return originalFetch(url, options);
        }
    }

    // --- 动态分组tab实现 ---
    //通过cookie读取你的b站uid
    function getMyUid() {
        const match = document.cookie.match(/DedeUserID=([^;]+)/);
        return match ? match[1] : null;
    }
    //定义一个携带你cookie的fetch方法
    async function fetchJson(url) {
        const res = await fetch(url, { credentials: 'include' });
        return await res.json();
    }

    async function fetchUidsByTag(tagId, current = () => true) {
        if (!GLOBAL_STATE.myUid) GLOBAL_STATE.myUid = getMyUid();//确保拿到了当前用户的 ID

        let page = 1;
        let pageSize = 20;
        let allUids = [];
        let hasMore = true;

        while (hasMore) {
            if (!current()) return [];
            const url = `${API_CONFIG.TAG_USERS}?mid=${GLOBAL_STATE.myUid}&tagid=${tagId}&pn=${page}&ps=${pageSize}`;
            try {
                const json = await fetchJson(url);
                if (json.code !== 0) throw Error(json.message || `接口错误 ${json.code}`);//API 返回错误码，强制停止

                const data = json.data;
                if (!data || !data.length) {// 如果 data 是空的，或者长度为 0，说明没数据了，停止
                    hasMore = false;
                    break;
                }

                const uids = data.map(user => user.mid);// 使用map()把 mid (UID) 提取出来变成新数组
                allUids.push(...uids);//将得到的结果push到allUids

                if (data.length < pageSize) {
                    hasMore = false;
                } else {
                    page++;
                    await new Promise(r => setTimeout(r, 100));// 等待0.1秒，防止请求太快触发 B 站的 412/429 频率限制。
                }
            } catch (e) {
                throw e;
            }
        }
        return allUids;
    }

    // --- UI渲染与交互 ---

    async function forceFeedReload(current = () => true) {// 通过点按视频再点按全部达到强制刷新
        // 获取原生标签栏
        const nativeTabs = document.querySelectorAll('.bili-dyn-list-tabs__item');
        if (nativeTabs.length < 2) {
            console.warn('无法找到原生标签，尝试滚动刷新');
            window.scrollTo({ top: 0, behavior: 'auto' });
            return;
        }

        const selectedTab = [...nativeTabs].find(tab => tab.classList.contains('active')) || nativeTabs[0];
        const alternateTab = [...nativeTabs].find(tab => tab !== selectedTab);
        GLOBAL_STATE.consecutiveEmptyResponses = 0;// 切换标签时，重置熔断计数器
        alternateTab.click();
        await new Promise(r => setTimeout(r, 100));
        if (!current()) return;
        const latestTabs = document.querySelectorAll('.bili-dyn-list-tabs__item');
        const selectedIndex = [...nativeTabs].indexOf(selectedTab);
        (latestTabs[selectedIndex] || selectedTab).click();
        window.scrollTo({ top: 0, behavior: 'smooth' });//滚动回顶部
    }

    const STYLE_CSS = `
        .btft-container {
            background: var(--btft-background, var(--bg1, #ffffff));
            border-radius: 6px;
            padding: 0 10px;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            height: 48px;
            font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
            position: relative;
            width: 100%;
            box-sizing: border-box;
            border: 1px solid var(--btft-border, var(--line_regular, #f1f2f3));
        }
        .btft-scroll-area {
            min-width: 0;
            display: flex;
            flex-wrap: nowrap;
            overflow-x: auto;
            width: 100%;
            height: 100%;
            align-items: center;
            scrollbar-width: none;
            -ms-overflow-style: none;
            padding: 0 5px;
            scroll-behavior: smooth;
        }
        .btft-scroll-area::-webkit-scrollbar {
            display: none;
        }
        .btft-item {
            position: relative;
            margin-right: 24px;
            font-size: 14px;
            color: var(--btft-text, var(--text2, #61666d));
            cursor: pointer;
            height: 100%;
            display: flex;
            align-items: center;
            white-space: nowrap;
            flex-shrink: 0;
            transition: color 0.2s;
            user-select: none;
            background: transparent;
            border: 0;
            padding: 0;
            font-family: inherit;
        }
        .btft-container .btft-item:focus-visible {
            outline: 2px solid var(--btft-accent, #00aeec);
            outline-offset: -4px;
            border-radius: 4px;
        }
        .btft-container .btft-item:hover {
            color: var(--btft-accent, var(--brand_blue, #00aeec));
        }
        .btft-container .btft-item.active {
            color: var(--btft-accent, var(--brand_blue, #00aeec));
            font-weight: 600;
        }
        .btft-container .btft-item.loading {
            color: var(--btft-accent, var(--brand_blue, #00aeec));
            cursor: wait;
        }
        .btft-settings { flex-shrink: 0; color: var(--btft-accent); background: transparent; border: 0; cursor: pointer; padding: 8px; }
        .btft-status { position: absolute; top: 100%; left: 0; z-index: 5; font-size: 12px; background: var(--btft-background); color: var(--btft-text); max-width: 100%; }
        .btft-status:not(:empty) { padding: 6px 10px; border-radius: 4px; }
        .btft-config { width: min(700px, 90vw); max-height: 80vh; overflow: auto; border: 1px solid var(--btft-border); border-radius: 10px; background: var(--btft-background, #fff); color: var(--btft-text, #61666d); padding: 20px; font: 14px/1.6 sans-serif; }
        .btft-config::backdrop { background: rgba(0, 0, 0, .55); }
        .btft-config h3 { margin-top: 0; color: inherit; }
        .btft-config fieldset { border: 1px solid var(--btft-text); border-radius: 6px; margin: 10px 0; padding: 10px; }
        .btft-config input:not([type=checkbox]) { width: 160px; padding: 5px; border: 1px solid var(--btft-text); border-radius: 4px; background: var(--btft-background); color: inherit; }
        .btft-config button { background: transparent; color: var(--btft-accent); border: 1px solid var(--btft-accent); padding: 4px 10px; border-radius: 4px; margin: 6px; cursor: pointer; }
        .btft-choices { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; }
        .btft-choices label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
        .btft-choices input { accent-color: var(--btft-accent); }
        .btft-config [role=alert] { color: var(--btft-accent); }
    `;

    // Sample the actual native tab palette: Evolved's legacy dark mode does not
    // necessarily use Bilibili's --bg1 values. No settings or theme classes are changed.
    function followNativeTheme(bar, nativeTabs) {
        let frame = 0;
        const sample = () => {
            frame = 0;
            if (!bar.isConnected) return;
            nativeTabs = document.querySelector('.bili-dyn-list-tabs') || nativeTabs;
            if (!nativeTabs.isConnected) return;
            const nativeStyle = getComputedStyle(nativeTabs);
            const normalTab = nativeTabs.querySelector('.bili-dyn-list-tabs__item:not(.active)');
            const activeTab = nativeTabs.querySelector('.bili-dyn-list-tabs__item.active');
            let background = nativeStyle.backgroundColor;
            let parent = nativeTabs.parentElement;
            while ((!background || background === 'transparent' || background === 'rgba(0, 0, 0, 0)') && parent) {
                background = getComputedStyle(parent).backgroundColor;
                parent = parent.parentElement;
            }
            const palette = {
                '--btft-background': background,
                '--btft-text': getComputedStyle(normalTab || nativeTabs).color,
                '--btft-accent': activeTab ? getComputedStyle(activeTab).color : getComputedStyle(document.body).getPropertyValue('--theme-color'),
                '--btft-border': nativeStyle.borderTopStyle !== 'none' ? nativeStyle.borderTopColor : background,
            };
            for (const [key, value] of Object.entries(palette)) {
                if (value && bar.style.getPropertyValue(key) !== value) bar.style.setProperty(key, value);
            }
            bar.style.colorScheme = document.body.classList.contains('dark') ? 'dark' : 'light';
        };
        const schedule = () => { if (!frame) frame = setTimeout(sample, 50); };
        const themeObserver = new MutationObserver(schedule);
        for (const node of [document.documentElement, document.body]) {
            themeObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        }
        // Style insertion/removal and delayed Evolved stylesheet loading.
        themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'media', 'href'] });
        themeObserver.observe(nativeTabs, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
        document.addEventListener('load', schedule, true);
        const timer = setInterval(() => {
            if (!bar.isConnected) {
                clearInterval(timer);
                themeObserver.disconnect();
                document.removeEventListener('load', schedule, true);
                if (frame) clearTimeout(frame);
                return;
            }
            schedule();
        }, 1500);
        sample();
    }

    const CONFIG_VERSION = 1;
    let selectionVersion = 0;
    const memberCache = new Map();
    function defaultConfig(tags) {
        // Use the first two real groups as the initial labels so the script works
        // for accounts that do not have the example group names.
        const available = tags.filter(tag => Number(tag.tagid) !== 0);
        if (!available.length) return { version: CONFIG_VERSION, groups: [], restName: '其余分组', defaultFallback: true };
        const first = available[0];
        const second = available[1] || first;
        const secondName = second === first || second.name === first.name ? `${second.name}1` : second.name;
        return {
            version: CONFIG_VERSION,
            defaultFallback: true,
            groups: [
                { name: first.name, tagIds: [Number(first.tagid)] },
                { name: secondName, tagIds: [Number(second.tagid)] },
            ],
            restName: '其余分组',
        };
    }
    function configKey() { return `btft-combined-v1:${GLOBAL_STATE.myUid}`; }
    function validateConfig(config) {
        if (!config || config.version !== CONFIG_VERSION || !Array.isArray(config.groups)) throw Error('配置格式不正确');
        const used = new Set();
        const allowSharedFallback = config.defaultFallback === true;
        const groups = config.groups.map(g => {
            const name = String(g.name || '').trim();
            if (!name || name.length > 30) throw Error('每个标签需要 1～30 字的名称');
            if (!Array.isArray(g.tagIds) || !g.tagIds.length) throw Error(`“${name}”至少选择一个分组`);
            const tagIds = g.tagIds.map(Number);
            for (const id of tagIds) {
                if (!Number.isSafeInteger(id) || id === 0) throw Error('默认分组固定归入其余分组');
                if (used.has(id) && !allowSharedFallback) throw Error('同一个关注分组只能分配给一个标签');
                used.add(id);
            }
            return { name, tagIds };
        });
        const restName = String(config.restName || '').trim();
        if (!restName || restName.length > 30) throw Error('其余分组需要 1～30 字的名称');
        if (new Set(['全部动态', restName, ...groups.map(g => g.name)]).size !== groups.length + 2) throw Error('标签名称不能重复');
        return { version: CONFIG_VERSION, groups, restName };
    }
    function loadConfig(tags) {
        try {
            const raw = localStorage.getItem(configKey());
            if (raw) return validateConfig(JSON.parse(raw));
        } catch (error) { console.warn('[BTFT] 无法读取组合配置，使用默认配置', error); }
        return defaultConfig(tags);
    }
    function resolveTabs(tags, config) {
        const available = new Set(tags.map(t => Number(t.tagid)));
        const assigned = new Set(config.groups.flatMap(g => g.tagIds));
        return [
            { name: '全部动态', tagIds: null },
            ...config.groups.map(g => ({ name: g.name, tagIds: g.tagIds.filter(id => available.has(id)) })),
            { name: config.restName, tagIds: tags.map(t => Number(t.tagid)).filter(id => id === 0 || !assigned.has(id)) },
        ];
    }
    const MEMBER_TTL = 5 * 60 * 1000;
    const memberPending = new Map();
    const memberCounts = new Map();
    let activeMemberLoads = 0;
    const memberWaiters = [];
    function memberStorageKey() { return `btft-members-v1:${GLOBAL_STATE.myUid}`; }
    function initializeMemberCache(tags) {
        memberCounts.clear();
        tags.forEach(tag => memberCounts.set(Number(tag.tagid), Number(tag.count)));
        try {
            const saved = JSON.parse(localStorage.getItem(memberStorageKey()) || '{}');
            for (const [id, entry] of Object.entries(saved)) {
                const number = Number(id);
                if (memberCounts.has(number) && entry.count === memberCounts.get(number) &&
                    Date.now() - entry.time >= 0 && Date.now() - entry.time < MEMBER_TTL && Array.isArray(entry.uids)) memberCache.set(number, entry);
            }
        } catch (error) { console.warn('[BTFT] 成员缓存不可用', error); }
    }
    function persistMemberCache() {
        try {
            const valid = [...memberCache].filter(([id, entry]) => memberCounts.has(id) && Date.now() - entry.time < MEMBER_TTL);
            localStorage.setItem(memberStorageKey(), JSON.stringify(Object.fromEntries(valid)));
        } catch (error) { /* Quota/private mode: keep the in-memory cache working. */ }
    }
    async function getTagMembers(id) {
        const cached = memberCache.get(id);
        if (cached && Date.now() - cached.time < MEMBER_TTL) return cached.uids;
        if (memberPending.has(id)) return memberPending.get(id);
        const task = (async () => {
            if (activeMemberLoads >= 3) await new Promise(resolve => memberWaiters.push(resolve));
            else activeMemberLoads++;
            try {
                const uids = await fetchUidsByTag(id);
                memberCache.set(id, { time: Date.now(), count: memberCounts.get(id), uids });
                persistMemberCache();
                return uids;
            } finally {
                const next = memberWaiters.shift();
                if (next) next(); else activeMemberLoads--;
            }
        })();
        memberPending.set(id, task);
        try { return await task; }
        finally { if (memberPending.get(id) === task) memberPending.delete(id); }
    }
    async function fetchCombinedUids(tagIds, onProgress, current) {
        const result = new Set();
        let cursor = 0, done = 0;
        const worker = async () => {
            while (current() && cursor < tagIds.length) {
                const id = tagIds[cursor++];
                const uids = await getTagMembers(id);
                if (!current()) return;
                uids.forEach(uid => result.add(String(uid)));
                onProgress(++done, tagIds.length);
            }
        };
        onProgress(0, tagIds.length);
        await Promise.all(Array.from({ length: Math.min(3, tagIds.length) }, worker));
        return current() ? [...result] : null;
    }
    function openConfig(bar, tags, apply) {
        if (document.querySelector('.btft-config')) return;
        const draft = JSON.parse(JSON.stringify(loadConfig(tags)));
        const dialog = document.createElement('dialog');
        dialog.className = 'btft-config';
        dialog.setAttribute('aria-label', '配置组合分组');
        const body = document.createElement('div');
        const title = document.createElement('h3'); title.textContent = '配置组合分组';
        const intro = document.createElement('p'); intro.textContent = '每行生成一个标签，可勾选多个关注分组。未分配的分组与默认分组自动并入最后一个标签；以后新建的分组也会自动加入。';
        const rows = document.createElement('div');
        const status = document.createElement('p'); status.setAttribute('role', 'alert');
        const button = (name, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.onclick = fn; return b; };
        const render = () => {
            rows.replaceChildren();
            const claimed = new Set(draft.groups.flatMap(g => g.tagIds));
            draft.groups.forEach((group, index) => {
                const row = document.createElement('fieldset');
                const legend = document.createElement('legend'); legend.textContent = `标签 ${index + 1}`;
                const name = document.createElement('input'); name.value = group.name; name.maxLength = 30; name.setAttribute('aria-label', `标签 ${index + 1} 名称`); name.oninput = () => { group.name = name.value; };
                row.append(legend, name, button('上移', () => { if (index) { [draft.groups[index - 1], draft.groups[index]] = [group, draft.groups[index - 1]]; render(); } }), button('下移', () => { if (index < draft.groups.length - 1) { [draft.groups[index + 1], draft.groups[index]] = [group, draft.groups[index + 1]]; render(); } }), button('删除', () => { draft.groups.splice(index, 1); render(); }));
                const choices = document.createElement('div'); choices.className = 'btft-choices';
                tags.filter(t => Number(t.tagid) !== 0).forEach(tag => {
                    const id = Number(tag.tagid), label = document.createElement('label'), check = document.createElement('input');
                    check.type = 'checkbox'; check.checked = group.tagIds.includes(id); check.disabled = claimed.has(id) && !check.checked;
                    check.onchange = () => { group.tagIds = check.checked ? [...group.tagIds, id] : group.tagIds.filter(x => x !== id); render(); };
                    label.append(check, document.createTextNode(tag.name)); choices.append(label);
                });
                const missing = group.tagIds.filter(id => !tags.some(t => Number(t.tagid) === id));
                if (missing.length) row.append(button('移除已删除的分组', () => { group.tagIds = group.tagIds.filter(id => !missing.includes(id)); render(); }));
                row.append(choices); rows.append(row);
            });
        };
        const restLabel = document.createElement('label'); restLabel.textContent = '其余分组标签名称：';
        const rest = document.createElement('input'); rest.value = draft.restName; rest.maxLength = 30; rest.oninput = () => { draft.restName = rest.value; }; restLabel.append(rest);
        const preview = document.createElement('p');
        const refreshPreview = () => { const names = resolveTabs(tags, draft).at(-1).tagIds.map(id => tags.find(t => Number(t.tagid) === id)?.name); preview.textContent = `其余分组包含：${names.join('、') || '无'}`; };
        rows.addEventListener('change', refreshPreview); rows.addEventListener('click', refreshPreview);
        const close = () => { dialog.close(); };
        body.append(title, intro, rows, button('添加标签', () => { draft.groups.push({ name: '', tagIds: [] }); render(); refreshPreview(); }), restLabel, preview, status,
            button('保存并应用', () => {
                try {
                    const config = validateConfig(draft);
                    localStorage.setItem(configKey(), JSON.stringify(config));
                    apply(config); close();
                } catch (error) { status.textContent = error.message; }
            }), button('取消', close));
        dialog.append(body); bar.append(dialog);
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        render(); refreshPreview(); dialog.showModal();
    }
    function renderTabs(parentElement, nextSiblingElement, tags) {
        const bar = document.createElement('div'); bar.className = 'btft-container';
        const scrollArea = document.createElement('div'); scrollArea.className = 'btft-scroll-area';
        const status = document.createElement('div'); status.className = 'btft-status'; status.setAttribute('role', 'status');
        scrollArea.addEventListener('wheel', e => { if (e.deltaY) { e.preventDefault(); scrollArea.scrollLeft += e.deltaY; } }, { passive: false });
        const draw = config => {
            ++selectionVersion;
            GLOBAL_STATE.isFiltering = false; GLOBAL_STATE.targetUids = [];
            scrollArea.replaceChildren(); status.textContent = '';
            resolveTabs(tags, config).forEach((tab, index) => {
                const item = document.createElement('button'); item.type = 'button'; item.className = `btft-item${index === 0 ? ' active' : ''}`; item.textContent = tab.name;
                item.title = tab.tagIds === null ? '取消分组筛选' : tab.tagIds.map(id => tags.find(t => Number(t.tagid) === id)?.name).join('、') || '没有可用分组';
                item.onclick = async () => {
                    const version = ++selectionVersion, current = () => selectionVersion === version;
                    status.textContent = '';
                    scrollArea.querySelectorAll('.btft-item').forEach(b => b.classList.remove('loading'));
                    try {
                        let uids = [];
                        if (tab.tagIds !== null) {
                            item.classList.add('loading');
                            uids = await fetchCombinedUids(tab.tagIds, (done, total) => { status.textContent = `正在读取“${tab.name}”分组 ${done}/${total}…`; }, current);
                            if (!current()) return;
                        }
                        GLOBAL_STATE.targetUids = uids;
                        GLOBAL_STATE.isFiltering = tab.tagIds !== null;
                        scrollArea.querySelectorAll('.btft-item').forEach(b => b.classList.toggle('active', b === item));
                        status.textContent = tab.tagIds !== null && !uids.length ? '该组合暂无关注用户。' : '';
                        await forceFeedReload(current);
                    } catch (error) {
                        if (current()) status.textContent = `加载失败：${error.message}。保留原筛选，可点击重试。`;
                    } finally { if (current()) item.classList.remove('loading'); }
                };
                scrollArea.append(item);
            });
        };
        const settings = document.createElement('button'); settings.type = 'button'; settings.className = 'btft-settings'; settings.textContent = '配置';
        const refreshMembers = document.createElement('button'); refreshMembers.type = 'button'; refreshMembers.className = 'btft-settings'; refreshMembers.textContent = '更新成员';
        refreshMembers.title = '关注分组成员变动后，清除成员缓存并重新读取当前标签';
        refreshMembers.onclick = async () => {
            refreshMembers.disabled = true;
            try {
                await Promise.allSettled([...memberPending.values()]);
                memberCache.clear();
                try { localStorage.removeItem(memberStorageKey()); } catch (error) { /* optional storage */ }
                feedCache.clear();
                scrollArea.querySelector('.btft-item.active')?.click();
            } finally { refreshMembers.disabled = false; }
        };
        settings.onclick = () => openConfig(bar, tags, config => { draw(config); forceFeedReload(); });
        bar.append(scrollArea, settings, refreshMembers, status); parentElement.insertBefore(bar, nextSiblingElement);
        initializeMemberCache(tags);
        draw(loadConfig(tags)); followNativeTheme(bar, nextSiblingElement);
    }

    async function initUI() {
        GLOBAL_STATE.myUid = getMyUid();
        if (!GLOBAL_STATE.myUid) return;// 没登录就直接退出

        // Based on chnaxoeng/bilibili-timeline-filter-tab (MIT); extended by dust-iny.
        const styleEl = document.createElement('style');
        styleEl.id = 'btft-style';
        styleEl.textContent = STYLE_CSS;
        document.head.appendChild(styleEl);// 把 CSS 样式表插到网页头部

        let tagsData = [];
        try {
            const res = await fetchJson(API_CONFIG.TAGS);// 异步请求分组数据
            if (res.code === 0) tagsData = res.data;
        } catch(e) { console.error(e); }

        const waitForTarget = setInterval(() => {
            const targetElement = document.querySelector('.bili-dyn-list-tabs');//寻找B站原本的标签栏 (.bili-dyn-list-tabs)
            if (targetElement && !document.querySelector('.btft-container')) {
                clearInterval(waitForTarget);
                renderTabs(targetElement.parentNode, targetElement, tagsData);
            }
        }, 500);
    }

    if (document.readyState === 'loading') {//网页loading好了再注入
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }

})();