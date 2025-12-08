import { extension_settings, saveMetadataDebounced } from "../../../../extensions.js";
import { eventSource, event_types, chat_metadata, name1, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from "../../../../../script.js";
import { loadWorldInfo, saveWorldInfo, world_names, world_info } from "../../../../world-info.js";
import { getContext } from "../../../../st-context.js";
import { streamingGeneration } from "../streaming-generation.js";

// Story Outline 注入模块名称
const STORY_OUTLINE_MODULE = 'LittleWhiteBox_StoryOutline';
import { 
    buildSmsMessages, buildSummaryMessages, buildSmsHistoryContent, buildExistingSummaryContent,
    buildNpcGenerationMessages, formatNpcToWorldbookContent, buildExtractStrangersMessages,
    buildWorldGenMessages, buildWorldSimMessages, buildSceneSwitchMessages, buildInviteMessages,
    buildOverlayHtml, MOBILE_LAYOUT_STYLE, DESKTOP_LAYOUT_STYLE, getPromptConfigPayload, setPromptConfig
} from "./story-outline-prompt.js";

const EXT_ID = "LittleWhiteBox";
const iframePath = `scripts/extensions/third-party/${EXT_ID}/Story_outline/Story_outline.html`;
const STORAGE_KEYS = { global: 'LittleWhiteBox_StoryOutline_GlobalSettings', comm: 'LittleWhiteBox_StoryOutline_CommSettings' };

let overlayCreated = false, frameReady = false, currentMesId = null, pendingFrameMessages = [];

// ================== 通用工具 ==================
const isMobile = () => window.innerWidth <= 768;
const safeJson = (fn) => { try { return fn(); } catch { return null; } };
const getStorage = (key, def) => safeJson(() => JSON.parse(localStorage.getItem(key))) || def;
const setStorage = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

const extractJson = (str, isArray = false) => {
    if (!str) return null;

    // 如果已经是对象/数组，直接返回
    if (typeof str !== 'string') {
        return str;
    }

    // 1. 尝试把整个字符串当成 JSON 解析
    let top = safeJson(() => JSON.parse(str));
    if (top && typeof top === 'object') {
        // 兼容 OpenAI / Chat Completions 风格：{ choices: [{ message: { content, reasoning_content } }] }
        if (Array.isArray(top.choices) && top.choices[0]?.message) {
            const msg = top.choices[0].message;
            let inner = '';

            if (typeof msg.content === 'string' && msg.content.trim()) {
                inner = msg.content;
            } else if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
                inner = msg.reasoning_content;
            }

            if (inner) {
                str = inner;
            } else {
                // 没有内容可用，交给重试逻辑处理
                return null;
            }
        } else {
            // 顶层本身就是我们要的 JSON（对象或数组）
            if (!isArray || Array.isArray(top)) {
                return top;
            }
            // 如果预期是数组但这里是对象，继续往下尝试从文本中截取
        }
    }

    // 2. 从文本中截取第一个 {...} 或 [...] 片段
    const match = str.match(isArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
    let jsonText = match?.[0] || str;

    // 2.1 先按原样尝试解析
    let parsed = safeJson(() => JSON.parse(jsonText));
    if (parsed) return parsed;

    // 3. 常见错误兜底修复

    // 3.1 单引号 JSON：'key': 'value' 或 ['a','b'] 这种
    if (jsonText.includes("':") || jsonText.includes("['") || jsonText.includes("',")) {
        const fixedSingle = jsonText.replace(/'/g, '"');
        parsed = safeJson(() => JSON.parse(fixedSingle));
        if (parsed) return parsed;
        jsonText = fixedSingle;
    }

    // 3.2 修复字符串内部未转义的双引号，例如 "他说 "哈，我可不喜欢你" 然后走开"
    const fixInnerQuotes = s => s.replace(
        /"((?:[^"\\]|\\.)*)"/g,
        (m, inner) => `"${inner.replace(/(?<!\\)"/g, '\\"')}"`
    );

    const fixedQuotes = fixInnerQuotes(jsonText);
    if (fixedQuotes !== jsonText) {
        parsed = safeJson(() => JSON.parse(fixedQuotes));
        if (parsed) return parsed;
    }

    return null;
};

const validators = {
    summary: o => o?.summary,
    npc: o => o?.name && o?.aliases,
    array: o => Array.isArray(o),
    scene: o => o?.review && o?.scene_setup,
    invite: o => typeof o?.invite === 'boolean' && o?.reply,
    // 世界数据校验：故事模式必须包含 meta + timeline；
    // 辅助模式只要求 world 或 maps 存在（不强制大纲与时间线）。
    world: o => {
        const mode = (getGlobalSettings().mode || 'story');
        if (mode === 'assist') {
            return !!o && (!!o.world || !!o.maps);
        }
        return !!(o && o.meta && o.timeline);
    }
};

function getSettings() {
    const ext = extension_settings[EXT_ID] ||= {};
    ext.storyOutline ||= { enabled: true };
    return ext;
}

function getOutlineStore() {
    if (!chat_metadata) return null;
    const ext = chat_metadata.extensions ||= {};
    const lwb = ext[EXT_ID] ||= {};
    return lwb.storyOutline ||= {
        mapData: null, stage: 0, deviationScore: 0,
        outlineData: { meta: null, timeline: null, world: null, outdoor: null, indoor: null, sceneSetup: null, strangers: null, contacts: null },
        // 预设 Story Outline 默认勾选：除陌路人/联络人外的所有部分
        dataChecked: { meta: true, timeline: true, world: true, outdoor: true, indoor: true, sceneSetup: true, strangers: false, contacts: false }
    };
}

const getGlobalSettings = () => getStorage(STORAGE_KEYS.global, { apiUrl: '', apiKey: '', model: '', mode: 'assist' });
const saveGlobalSettings = s => setStorage(STORAGE_KEYS.global, s);
const getCommSettings = () => ({ historyCount: 50, npcPosition: 0, npcOrder: 100, ...getStorage(STORAGE_KEYS.comm, {}) });
const saveCommSettings = s => setStorage(STORAGE_KEYS.comm, s);

// ================== LLM 调用 ==================
async function callLLM(promptOrMessages, useRaw = false) {
    const { apiUrl, apiKey, model } = getGlobalSettings();
    const opts = { as: 'user', nonstream: 'true' };
    
    if (apiUrl?.trim()) {
        Object.assign(opts, { api: 'openai', apiurl: apiUrl.trim(), ...(apiKey && { apipassword: apiKey }), ...(model && { model }) });
    }
    
    if (useRaw) {
        if (Array.isArray(promptOrMessages)) {
            opts.top = promptOrMessages.map(m => `${m.role === 'system' ? 'sys' : m.role}={${m.content}}`).join(';');
            return String(await streamingGeneration.xbgenrawCommand(opts, '') || '').trim();
        }
        return String(await streamingGeneration.xbgenrawCommand(opts, promptOrMessages) || '').trim();
    }
    opts.position = 'history';
    opts.lock = 'on';
    return String(await streamingGeneration.xbgenCommand(opts, promptOrMessages) || '').trim();
}

async function callLLMWithRetry({ messages, useRaw = true, isArray = false, validate, maxRetries = 3 }) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await callLLM(messages, useRaw);
            const parsed = extractJson(result, isArray);
            if (parsed && validate(parsed)) return parsed;
        } catch {}
        if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 1000));
    }
    return null;
}

// ================== 世界书工具 ==================
async function getCharacterWorldbooks() {
    const ctx = getContext();
    const char = ctx.characters?.[ctx.characterId];
    if (!char) return [];
    
    const books = [];
    const primary = char.data?.extensions?.world;
    if (primary && world_names?.includes(primary)) books.push(primary);
    
    const extra = (world_info?.charLore || []).find(e => e.name === char.avatar)?.extraBooks || [];
    extra.forEach(b => { if (world_names?.includes(b) && !books.includes(b)) books.push(b); });
    return books;
}

async function findWorldbookEntry(uid) {
    const uidNum = parseInt(uid, 10);
    if (isNaN(uidNum)) return null;
    
    for (const book of await getCharacterWorldbooks()) {
        const data = await loadWorldInfo(book);
        if (data?.entries?.[uidNum]) return { bookName: book, entry: data.entries[uidNum], uidNumber: uidNum, worldData: data };
    }
    return null;
}

async function searchWorldbookByName(name) {
    const nameLower = (name || '').toLowerCase().trim();
    for (const book of await getCharacterWorldbooks()) {
        const data = await loadWorldInfo(book);
        if (!data?.entries) continue;
        for (const [uid, entry] of Object.entries(data.entries)) {
            const keys = Array.isArray(entry.key) ? entry.key : [];
            if (keys.some(k => { const kl = (k || '').toLowerCase().trim(); return kl === nameLower || kl.includes(nameLower) || nameLower.includes(kl); })) {
                return { uid: String(uid), bookName: book, entry };
            }
        }
    }
    return null;
}

// ================== 剧情大纲格式化 ==================
function getVisibleOnionLayers(stage) {
    const order = ['L1_Surface', 'L2_Traces', 'L3_Mechanism', 'L4_Nodes', 'L5_Core', 'L6_Drive', 'L7_Consequence'];
    // 0=L2以下，1=L3以下 ... 4=L6以下，5及以上=L7以下；只设上限，不设下限
    const cappedStage = Math.min(Math.max(0, stage), 5);
    return order.slice(0, cappedStage + 2);
}

function formatMapDataAsPrompt() {
    const store = getOutlineStore();
    if (!store?.outlineData) return "";
    
    const { outlineData: d, dataChecked: c } = store;
    const stage = store.stage ?? 0;
    let text = "[Story Outline - 剧情地图数据]\n\n", has = false;
    
    if (c?.meta && d.meta) {
        has = true;
        text += "【大纲】\n(注意：以下信息是目前世界可呈现给玩家的全部认知，玩家获取信息的困难度按层级递增。**严禁**引入任何未在此列表中出现的更深层级真相。如果遇到未解之谜，请保持神秘感。)\n\n";
        if (d.meta.truth?.overview) text += `核心真相（绝密）: ${d.meta.truth.overview}\n\n`;
        
        const onion = d.meta.truth?.onion_layers;
        if (onion) {
            text += "当前可呈现的层级:\n";
            getVisibleOnionLayers(stage).forEach(k => {
                const l = onion[k];
                if (!l) return;
                const name = k.replace('_', ' - ');
                if (Array.isArray(l)) l.forEach((item, i) => { text += `- [${name}${i+1}] ${item.desc}: ${item.logic}\n`; });
                else text += `- [${name}] ${l.desc}: ${l.logic}\n`;
            });
            text += "\n";
        }
        
        if (d.meta.outcomes) {
            text += "可能结局:\n";
            ['default_end', 'intervention_end', 'resolution_end'].forEach(k => {
                if (d.meta.outcomes[k]) text += `- ${k.replace('_end', '结局')}: ${d.meta.outcomes[k]}\n`;
            });
            text += "\n";
        }
    }
    
    if (c?.timeline && d.timeline?.length) {
        const cur = d.timeline.find(t => t.stage === stage);
        if (cur) { has = true; text += `【当前时间线】\n阶段: ${cur.stage}\n${cur.state ? `状态: ${cur.state}\n` : ''}${cur.event ? `事件: ${cur.event}\n` : ''}\n`; }
    }
    
    [['outdoor', '大地图'], ['indoor', '局部地图']].forEach(([k, n]) => {
        if (c?.[k] && d[k]?.description) { has = true; text += `【${n}】\n${d[k].description}\n\n`; }
    });
    
    if (c?.world && d.world?.news?.length) {
        has = true; text += "【世界资讯】\n";
        d.world.news.forEach(n => { text += `- ${n.title}: ${n.content}\n`; });
        text += "\n";
    }
    
    [['contacts', '联络人'], ['strangers', '陌路人']].forEach(([k, n]) => {
        if (c?.[k] && d[k]?.length) {
            has = true; text += `【${n}】\n`;
            d[k].forEach(p => { text += `- ${p.name}${p.location ? ` (${p.location})` : ''}${p.info ? `: ${p.info}` : ''}\n`; });
            text += "\n";
        }
    });
    
    return has ? text.trim() : "";
}

// ================== 剧情大纲注入主对话 ==================
/**
 * 将勾选的剧情大纲数据注入到主对话流程中
 * 使用 SillyTavern 的 setExtensionPrompt API
 */
function injectStoryOutlineToChat() {
    if (!getSettings().storyOutline?.enabled) {
        // 如果功能被禁用，清除注入
        setExtensionPrompt(STORY_OUTLINE_MODULE, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    
    const store = getOutlineStore();
    if (!store) {
        // 没有聊天数据，清除注入
        setExtensionPrompt(STORY_OUTLINE_MODULE, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    
    // 检查是否有任何数据被勾选
    const { dataChecked } = store;
    const hasAnyChecked = dataChecked && Object.values(dataChecked).some(v => v === true);
    
    if (!hasAnyChecked) {
        // 没有勾选任何数据，清除注入
        setExtensionPrompt(STORY_OUTLINE_MODULE, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    
    // 生成剧情大纲文本
    const outlineText = formatMapDataAsPrompt();
    
    if (!outlineText) {
        // 没有生成内容，清除注入
        setExtensionPrompt(STORY_OUTLINE_MODULE, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    
    // 获取通讯设置中的注入位置配置（如果有的话）
    const comm = getCommSettings();
    const position = comm.outlinePosition ?? extension_prompt_types.IN_CHAT; // 默认: 在聊天中
    const depth = comm.outlineDepth ?? 4; // 默认深度: 4
    const role = comm.outlineRole ?? extension_prompt_roles.SYSTEM; // 默认角色: system
    
    // 注入剧情大纲到对话
    setExtensionPrompt(
        STORY_OUTLINE_MODULE,
        outlineText,
        position,
        depth,
        false, // scan - 是否包含在世界书扫描中
        role
    );
    
    console.debug(`[Story Outline] 剧情大纲已注入到对话。位置: ${position}, 深度: ${depth}, 角色: ${role}, 内容长度: ${outlineText.length}`);
}

// ================== iframe通讯 ==================
function postToFrame(payload) {
    const iframe = document.getElementById("xiaobaix-story-outline-iframe");
    if (!iframe?.contentWindow || !frameReady) { pendingFrameMessages.push(payload); return; }
    iframe.contentWindow.postMessage({ source: "LittleWhiteBox", ...payload }, "*");
}

function flushPendingMessages() {
    if (!frameReady) return;
    const iframe = document.getElementById("xiaobaix-story-outline-iframe");
    pendingFrameMessages.forEach(p => iframe?.contentWindow?.postMessage({ source: "LittleWhiteBox", ...p }, "*"));
    pendingFrameMessages = [];
}

function sendSettingsToFrame() {
    const store = getOutlineStore();
    postToFrame({
        type: "LOAD_SETTINGS", globalSettings: getGlobalSettings(), commSettings: getCommSettings(),
        stage: store?.stage ?? 0, deviationScore: store?.deviationScore ?? 0,
        dataChecked: store?.dataChecked || {}, outlineData: store?.outlineData || {},
        promptConfig: getPromptConfigPayload?.()
    });
}

function loadAndSendMapData() {
    const store = getOutlineStore();
    if (store?.mapData) postToFrame({ type: "LOAD_MAP_DATA", mapData: store.mapData });
    sendSettingsToFrame();
}

// ================== 请求处理器 ==================
const replyFrame = (type, requestId, data) => postToFrame({ type, requestId, ...data });
const replyError = (type, requestId, error) => replyFrame(type, requestId, { error });

async function handleFetchModels({ apiUrl, apiKey }) {
    try {
        let models = [];
        if (!apiUrl) {
            for (const ep of ['/api/backends/chat-completions/models', '/api/openai/models']) {
                try {
                    const r = await fetch(ep, { headers: { 'Content-Type': 'application/json' } });
                    if (r.ok) { const j = await r.json(); models = (j.data || j || []).map(m => m.id || m.name || m).filter(m => typeof m === 'string'); if (models.length) break; }
                } catch {}
            }
            if (!models.length) throw new Error('无法从酒馆获取模型列表');
        } else {
            const h = { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) };
            const r = await fetch(apiUrl.replace(/\/$/, '') + '/models', { headers: h });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json();
            models = (j.data || j || []).map(m => m.id || m.name || m).filter(m => typeof m === 'string');
        }
        postToFrame({ type: "FETCH_MODELS_RESULT", models });
    } catch (e) { postToFrame({ type: "FETCH_MODELS_RESULT", error: e.message }); }
}

async function handleTestConnection({ apiUrl, apiKey, model }) {
    try {
        if (!apiUrl) {
            for (const ep of ['/api/backends/chat-completions/status', '/api/openai/models', '/api/backends/chat-completions/models']) {
                try { if ((await fetch(ep, { headers: { 'Content-Type': 'application/json' } })).ok) { postToFrame({ type: "TEST_CONN_RESULT", success: true, message: `连接成功${model ? ` (模型: ${model})` : ''}` }); return; } } catch {}
            }
            throw new Error('无法连接到酒馆API');
        }
        const h = { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) };
        if (!(await fetch(apiUrl.replace(/\/$/, '') + '/models', { headers: h })).ok) throw new Error('连接失败');
        postToFrame({ type: "TEST_CONN_RESULT", success: true, message: `连接成功${model ? ` (模型: ${model})` : ''}` });
    } catch (e) { postToFrame({ type: "TEST_CONN_RESULT", success: false, message: `连接失败: ${e.message}` }); }
}

async function handleCheckWorldbookUid({ uid, requestId }) {
    const uidNum = parseInt(uid, 10);
    if (!uid?.trim() || isNaN(uidNum)) return replyError("CHECK_WORLDBOOK_UID_RESULT", requestId, isNaN(uidNum) ? 'UID必须是数字' : '请输入有效的UID');
    
    const books = await getCharacterWorldbooks();
    if (!books.length) return replyError("CHECK_WORLDBOOK_UID_RESULT", requestId, '当前角色卡没有绑定世界书');
    
    for (const book of books) {
        const data = await loadWorldInfo(book);
        const entry = data?.entries?.[uidNum];
        if (entry) {
            const keys = Array.isArray(entry.key) ? entry.key : [];
            if (!keys.length) return replyError("CHECK_WORLDBOOK_UID_RESULT", requestId, `在「${book}」中找到条目 UID ${uid}，但没有主要关键字`);
            return replyFrame("CHECK_WORLDBOOK_UID_RESULT", requestId, { primaryKeys: keys, worldbook: book, comment: entry.comment || '' });
        }
    }
    replyError("CHECK_WORLDBOOK_UID_RESULT", requestId, `在角色卡绑定的世界书中未找到 UID 为 ${uid} 的条目`);
}

async function handleSendSms({ requestId, contactName, worldbookUid, userMessage, chatHistory, summarizedCount }) {
    try {
        const ctx = getContext();
        const userName = name1 || ctx.name1 || '用户';
        let characterContent = '', existingSummaries = {};
        
        if (worldbookUid) {
            const entry = await findWorldbookEntry(worldbookUid);
            if (entry?.entry) {
                const content = entry.entry.content || '';
                const smsIdx = content.indexOf('[SMS_HISTORY_START]');
                characterContent = smsIdx !== -1 ? content.substring(0, smsIdx).trim() : content;
                
                const [start, end] = [content.indexOf('[SMS_HISTORY_START]'), content.indexOf('[SMS_HISTORY_END]')];
                if (start !== -1 && end !== -1) {
                    const parsed = safeJson(() => JSON.parse(content.substring(start + 19, end).trim()));
                    const sumItem = parsed?.find?.(i => typeof i === 'string' && i.startsWith('SMS_summary:'));
                    if (sumItem) existingSummaries = safeJson(() => JSON.parse(sumItem.substring(12))) || {};
                }
            }
        }
        
        let historyText = '';
        const sc = summarizedCount || 0;
        const sumKeys = Object.keys(existingSummaries).filter(k => k !== '_count').sort((a, b) => a - b);
        if (sumKeys.length) historyText = `[之前的对话摘要] ${sumKeys.map(k => existingSummaries[k]).join('；')}\n\n`;
        if (chatHistory?.length > 1) {
            const msgs = chatHistory.slice(sc, -1);
            if (msgs.length) historyText += msgs.map(m => `${m.type === 'sent' ? userName : contactName}：${m.text}`).join('\n');
        }
        
        const messages = buildSmsMessages({
            contactName, userName, storyOutline: formatMapDataAsPrompt(),
            historyCount: getCommSettings().historyCount || 50,
            smsHistoryContent: buildSmsHistoryContent(historyText), userMessage, characterContent
        });
        
        const reply = await callLLM(messages, true);
        replyFrame('SMS_RESULT', requestId, reply ? { reply } : { error: '生成回复失败，请重试' });
    } catch (e) { replyError('SMS_RESULT', requestId, `生成失败: ${e.message}`); }
}

async function handleLoadSmsHistory({ worldbookUid }) {
    const store = getOutlineStore();
    const contact = store?.outlineData?.contacts?.find(c => c.worldbookUid === worldbookUid);
    
    if (contact?.smsHistory?.messages?.length) {
        return postToFrame({ type: 'LOAD_SMS_HISTORY_RESULT', worldbookUid, messages: contact.smsHistory.messages, summarizedCount: contact.smsHistory.summarizedCount || 0 });
    }
    
    const entry = await findWorldbookEntry(worldbookUid);
    let messages = [];
    if (entry?.entry) {
        const content = entry.entry.content || '';
        const [start, end] = [content.indexOf('[SMS_HISTORY_START]'), content.indexOf('[SMS_HISTORY_END]')];
        if (start !== -1 && end !== -1) {
            const parsed = safeJson(() => JSON.parse(content.substring(start + 19, end).trim()));
            parsed?.forEach?.(item => {
                if (typeof item === 'string' && !item.startsWith('SMS_summary:')) {
                    const idx = item.indexOf(':');
                    if (idx > 0) messages.push({ type: item.substring(0, idx) === '{{user}}' ? 'sent' : 'received', text: item.substring(idx + 1) });
                }
            });
        }
    }
    postToFrame({ type: 'LOAD_SMS_HISTORY_RESULT', worldbookUid, messages, summarizedCount: 0 });
}

async function handleSaveSmsHistory({ worldbookUid, messages, contactName, summarizedCount }) {
    const entry = await findWorldbookEntry(worldbookUid);
    if (!entry) return;
    
    const { bookName, entry: e, worldData } = entry;
    let content = e.content || '';
    const charName = contactName || e.key?.[0] || '角色';
    let existingSumStr = '';
    
    const [start, end] = [content.indexOf('[SMS_HISTORY_START]'), content.indexOf('[SMS_HISTORY_END]')];
    if (start !== -1 && end !== -1) {
        const parsed = safeJson(() => JSON.parse(content.substring(start + 19, end).trim()));
        existingSumStr = parsed?.find?.(i => typeof i === 'string' && i.startsWith('SMS_summary:')) || '';
        content = content.substring(0, start).trimEnd() + content.substring(end + 17);
    }
    
    if (messages?.length) {
        const sc = summarizedCount || 0;
        const simplified = messages.slice(sc).map(m => `${m.type === 'sent' ? '{{user}}' : charName}:${m.text}`);
        const arr = existingSumStr ? [existingSumStr, ...simplified] : simplified;
        content = content.trimEnd() + `\n\n[SMS_HISTORY_START]\n${JSON.stringify(arr)}\n[SMS_HISTORY_END]`;
    }
    
    e.content = content.trim();
    await saveWorldInfo(bookName, worldData);
}

async function handleCompressSms({ requestId, worldbookUid, messages, contactName, summarizedCount }) {
    const sc = summarizedCount || 0;
    try {
        const ctx = getContext();
        const userName = name1 || ctx.name1 || '用户';
        const entry = await findWorldbookEntry(worldbookUid);
        let existingSummaries = {};
        
        if (entry?.entry) {
            const content = entry.entry.content || '';
            const [start, end] = [content.indexOf('[SMS_HISTORY_START]'), content.indexOf('[SMS_HISTORY_END]')];
            if (start !== -1 && end !== -1) {
                const parsed = safeJson(() => JSON.parse(content.substring(start + 19, end).trim()));
                const sumItem = parsed?.find?.(i => typeof i === 'string' && i.startsWith('SMS_summary:'));
                if (sumItem) existingSummaries = safeJson(() => JSON.parse(sumItem.substring(12))) || {};
            }
        }
        
        const keepRecent = 4, toSumEnd = Math.max(sc, messages.length - keepRecent);
        if (toSumEnd <= sc) return replyError('COMPRESS_SMS_RESULT', requestId, '没有足够的新消息需要总结');
        
        const toSum = messages.slice(sc, toSumEnd);
        if (toSum.length < 2) return replyError('COMPRESS_SMS_RESULT', requestId, '需要至少2条消息才能进行总结');
        
        const convText = toSum.map(m => `${m.type === 'sent' ? userName : contactName}：${m.text}`).join('\n');
        const sumKeys = Object.keys(existingSummaries).filter(k => k !== '_count').sort((a, b) => a - b);
        const existingSumText = sumKeys.map(k => `${k}. ${existingSummaries[k]}`).join('\n');
        
        const parsed = await callLLMWithRetry({
            messages: buildSummaryMessages({ existingSummaryContent: buildExistingSummaryContent(existingSumText), conversationText: convText }),
            validate: validators.summary
        });
        
        const summary = parsed?.summary?.trim?.();
        if (!summary) return replyError('COMPRESS_SMS_RESULT', requestId, 'ECHO：总结生成出错，请重试');
        
        const newSumCount = toSumEnd;
        
        if (entry) {
            const { bookName, entry: e, worldData } = entry;
            let content = e.content || '';
            const charName = contactName || e.key?.[0] || '角色';
            const [start, end] = [content.indexOf('[SMS_HISTORY_START]'), content.indexOf('[SMS_HISTORY_END]')];
            if (start !== -1 && end !== -1) content = content.substring(0, start).trimEnd() + content.substring(end + 17);
            
            const nextKey = Math.max(0, ...Object.keys(existingSummaries).filter(k => k !== '_count').map(k => parseInt(k, 10)).filter(n => !isNaN(n))) + 1;
            existingSummaries[String(nextKey)] = summary;
            
            const remaining = messages.slice(toSumEnd).map(m => `${m.type === 'sent' ? '{{user}}' : charName}:${m.text}`);
            const arr = [`SMS_summary:${JSON.stringify(existingSummaries)}`, ...remaining];
            content = content.trimEnd() + `\n\n[SMS_HISTORY_START]\n${JSON.stringify(arr)}\n[SMS_HISTORY_END]`;
            
            e.content = content.trim();
            await saveWorldInfo(bookName, worldData);
        }
        
        replyFrame('COMPRESS_SMS_RESULT', requestId, { summary, newSummarizedCount: newSumCount });
    } catch (e) { replyError('COMPRESS_SMS_RESULT', requestId, `压缩失败: ${e.message}`); }
}

async function handleCheckStrangerWorldbook({ requestId, strangerName }) {
    const result = await searchWorldbookByName(strangerName);
    postToFrame({
        type: 'CHECK_STRANGER_WORLDBOOK_RESULT', requestId,
        found: !!result, ...(result && { worldbookUid: result.uid, worldbook: result.bookName, entryName: result.entry.comment || result.entry.key?.[0] || strangerName })
    });
}

async function handleGenerateNpc({ requestId, strangerName, strangerInfo }) {
    try {
        const ctx = getContext();
        const char = ctx.characters?.[ctx.characterId];
        if (!char) return replyError('GENERATE_NPC_RESULT', requestId, '未找到当前角色卡');
        
        const primaryBook = char.data?.extensions?.world;
        if (!primaryBook || !world_names?.includes(primaryBook)) return replyError('GENERATE_NPC_RESULT', requestId, '角色卡未绑定世界书，请先绑定世界书');
        
        const comm = getCommSettings();
        const messages = buildNpcGenerationMessages({ strangerName, strangerInfo: strangerInfo || '(无描述)', storyOutline: formatMapDataAsPrompt(), historyCount: comm.historyCount || 50 });
        const npcData = await callLLMWithRetry({ messages, validate: validators.npc });
        
        if (!npcData?.name) return replyError('GENERATE_NPC_RESULT', requestId, 'NPC 生成失败：无法解析 JSON 数据');
        
        const worldData = await loadWorldInfo(primaryBook);
        if (!worldData) return replyError('GENERATE_NPC_RESULT', requestId, `无法加载世界书: ${primaryBook}`);
        
        const { createWorldInfoEntry } = await import("../../../../world-info.js");
        const newEntry = createWorldInfoEntry(primaryBook, worldData);
        if (!newEntry) return replyError('GENERATE_NPC_RESULT', requestId, '创建世界书条目失败');
        
        Object.assign(newEntry, {
            key: npcData.aliases || [npcData.name], comment: npcData.name, content: formatNpcToWorldbookContent(npcData),
            constant: false, selective: true, disable: false,
            position: typeof comm.npcPosition === 'number' ? comm.npcPosition : 0,
            order: typeof comm.npcOrder === 'number' ? comm.npcOrder : 100
        });
        
        await saveWorldInfo(primaryBook, worldData, true);
        replyFrame('GENERATE_NPC_RESULT', requestId, { success: true, npcData, worldbookUid: String(newEntry.uid), worldbook: primaryBook });
    } catch (e) { replyError('GENERATE_NPC_RESULT', requestId, `生成失败: ${e.message}`); }
}

async function handleExtractStrangers({ requestId, existingContacts, existingStrangers }) {
    try {
        const comm = getCommSettings();
        const messages = buildExtractStrangersMessages({ storyOutline: formatMapDataAsPrompt(), historyCount: comm.historyCount || 50, existingContacts: existingContacts || [], existingStrangers: existingStrangers || [] });
        const data = await callLLMWithRetry({ messages, isArray: true, validate: validators.array });
        
        if (!Array.isArray(data)) return replyError('EXTRACT_STRANGERS_RESULT', requestId, '提取失败：无法解析 JSON 数据');
        
        const strangers = data.filter(s => s?.name).map(s => ({
            name: s.name, avatar: s.name[0] || '?', color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
            location: s.location || '未知', info: s.info || ''
        }));
        replyFrame('EXTRACT_STRANGERS_RESULT', requestId, { success: true, strangers });
    } catch (e) { replyError('EXTRACT_STRANGERS_RESULT', requestId, `提取失败: ${e.message}`); }
}

async function handleSceneSwitch({ requestId, prevLocationName, prevLocationInfo, targetLocationName, targetLocationType, targetLocationInfo, playerAction }) {
    try {
        const store = getOutlineStore();
        const comm = getCommSettings();
        const stage = store?.stage || 0;
        const timeline = store?.outlineData?.timeline?.find(t => t.stage === stage);
        const mode = (getGlobalSettings().mode || 'story');
        
        const messages = buildSceneSwitchMessages({
            prevLocationName: prevLocationName || '未知地点', prevLocationInfo: prevLocationInfo || '',
            targetLocationName: targetLocationName || '未知地点', targetLocationType: targetLocationType || 'sub', targetLocationInfo: targetLocationInfo || '',
            storyOutline: formatMapDataAsPrompt(), stage, currentTimeline: timeline, historyCount: comm.historyCount || 50, playerAction: playerAction || '',
            mode
        });
        
        const data = await callLLMWithRetry({ messages, validate: validators.scene });
        if (!data?.scene_setup) return replyError('SCENE_SWITCH_RESULT', requestId, '场景生成失败：无法解析 JSON 数据');
        
        const delta = data.review?.deviation?.score_delta || 0;
        const oldScore = store?.deviationScore || 0;
        const newScore = Math.min(100, Math.max(0, oldScore + delta));
        if (store) { store.deviationScore = newScore; saveMetadataDebounced?.(); }
        
        const strangers = (data.scene_setup?.strangers || []).filter(s => s?.name).map(s => ({
            name: s.name, avatar: s.name[0] || '?', color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
            location: s.location || targetLocationName, info: s.info || ''
        }));
        
        replyFrame('SCENE_SWITCH_RESULT', requestId, {
            success: true, sceneData: { review: data.review, sideStory: data.scene_setup?.side_story, localMap: data.scene_setup?.local_map, strangers, scoreDelta: delta, newScore }
        });
    } catch (e) { replyError('SCENE_SWITCH_RESULT', requestId, `场景切换失败: ${e.message}`); }
}

async function handleExecuteSlashCommand({ command, sceneDescription }) {
    try {
        const { executeSlashCommands } = await import('../../../../slash-commands.js');
        if (executeSlashCommands) {
            await executeSlashCommands(command);
            if (sceneDescription) await executeSlashCommands(`/narrator ${sceneDescription}`);
        }
    } catch (e) {
        try { const inp = document.getElementById('send_textarea'); if (inp) { inp.value = command.replace(/^\/send\s*/, ''); inp.dispatchEvent(new Event('input', { bubbles: true })); } } catch {}
    }
}

async function handleSendInvite({ requestId, contactName, contactUid, targetLocation, smsHistory, userLocation }) {
    try {
        const comm = getCommSettings();
        let charContent = '';
        if (contactUid) {
            const entries = Object.values(world_info?.entries || world_info || {});
            charContent = entries.find(e => e.uid?.toString() === contactUid.toString())?.content || '';
        }
        
        const messages = buildInviteMessages({
            contactName, userName: name1 || '{{user}}', targetLocation, storyOutline: formatMapDataAsPrompt(),
            historyCount: comm.historyCount || 50, smsHistoryContent: buildSmsHistoryContent(smsHistory || ''), characterContent: charContent
        });
        
        const data = await callLLMWithRetry({ messages, validate: validators.invite });
        if (typeof data?.invite !== 'boolean') return replyError('SEND_INVITE_RESULT', requestId, '邀请处理失败：无法解析 JSON 数据');
        
        let sendNow = false;
        if (data.invite && userLocation === targetLocation) {
            sendNow = true;
            try { const { executeSlashCommands } = await import('../../../../slash-commands.js'); await executeSlashCommands?.(`/send ${name1 || '{{user}}'}邀请了${contactName}过来，${contactName}已经到达。`); } catch {}
        }
        
        replyFrame('SEND_INVITE_RESULT', requestId, { success: true, inviteData: { accepted: data.invite, reply: data.reply, targetLocation, sendNow } });
    } catch (e) { replyError('SEND_INVITE_RESULT', requestId, `邀请处理失败: ${e.message}`); }
}

async function handleGenerateWorld({ requestId, playerRequests }) {
    try {
        const mode = (getGlobalSettings().mode || 'story');
        const messages = buildWorldGenMessages({ mode, playerRequests: playerRequests || '', historyCount: getCommSettings().historyCount || 50 });
        const data = await callLLMWithRetry({ messages, validate: validators.world });
        // 对于故事模式要求 meta/timeline；辅助模式仅需 world 或 maps。
        if (!data || !validators.world(data)) {
            const msg = mode === 'assist'
                ? '世界生成失败：无法解析 JSON 数据（需包含 world 或 maps 字段）'
                : '世界生成失败：无法解析 JSON 数据';
            return replyError('GENERATE_WORLD_RESULT', requestId, msg);
        }
        
        const store = getOutlineStore();
        if (store) { store.stage = 0; store.deviationScore = 0; saveMetadataDebounced?.(); }
        
        replyFrame('GENERATE_WORLD_RESULT', requestId, { success: true, worldData: data });
    } catch (e) { replyError('GENERATE_WORLD_RESULT', requestId, `生成失败: ${e.message}`); }
}

async function handleSimulateWorld({ requestId, currentData }) {
    try {
        const mode = (getGlobalSettings().mode || 'story');
        const messages = buildWorldSimMessages({ mode, currentWorldData: currentData || '{}', historyCount: getCommSettings().historyCount || 50 });
        const data = await callLLMWithRetry({ messages, validate: validators.world });
        // 故事模式需要完整世界数据；辅助模式只关心 world/maps。
        if (!data || !validators.world(data)) {
            const msg = mode === 'assist'
                ? '世界推演失败：无法解析 JSON 数据（需包含 world 或 maps 字段）'
                : '世界推演失败：无法解析 JSON 数据';
            return replyError('SIMULATE_WORLD_RESULT', requestId, msg);
        }
        
        const store = getOutlineStore();
        if (store) {
            // 推演后的阶段仅由脚本控制递增，不接受模型返回的 stage
            store.stage = (store.stage || 0) + 1;
            saveMetadataDebounced?.();
        }
        
        replyFrame('SIMULATE_WORLD_RESULT', requestId, { success: true, simData: data });
    } catch (e) { replyError('SIMULATE_WORLD_RESULT', requestId, `推演失败: ${e.message}`); }
}

function handleSaveSettings(data) {
    if (data.globalSettings) saveGlobalSettings(data.globalSettings);
    if (data.commSettings) saveCommSettings(data.commSettings);
    
    const store = getOutlineStore();
    if (store) {
        if (data.stage !== undefined) store.stage = data.stage;
        if (data.deviationScore !== undefined) store.deviationScore = data.deviationScore;
        if (data.dataChecked) store.dataChecked = data.dataChecked;
        if (data.allData) store.outlineData = data.allData;
        store.updatedAt = Date.now();
        saveMetadataDebounced?.();
    }
    
    // 设置变更后，更新注入到主对话的剧情大纲
    injectStoryOutlineToChat();
}

function handleSavePrompts(data) {
    if (!data?.promptConfig) return;
    setPromptConfig?.(data.promptConfig, true);
    postToFrame({ type: "PROMPT_CONFIG_UPDATED", promptConfig: getPromptConfigPayload?.() });
}

function handleSaveContacts(data) {
    const store = getOutlineStore();
    if (!store) return;
    store.outlineData ||= {};
    if (data.contacts) store.outlineData.contacts = data.contacts;
    if (data.strangers) store.outlineData.strangers = data.strangers;
    store.updatedAt = Date.now();
    saveMetadataDebounced?.();
    
    // 联络人/陌路人变更后，更新注入
    injectStoryOutlineToChat();
}

function handleSaveAllData(data) {
    const store = getOutlineStore();
    if (store && data.allData) { 
        store.outlineData = data.allData; 
        store.updatedAt = Date.now(); 
        saveMetadataDebounced?.(); 
        
        // 数据变更后，更新注入
        injectStoryOutlineToChat();
    }
}

const handlers = {
    FRAME_READY: () => { frameReady = true; flushPendingMessages(); loadAndSendMapData(); },
    CLOSE_PANEL: hideOverlay,
    SAVE_MAP_DATA: d => { const s = getOutlineStore(); if (s && d.mapData) { s.mapData = d.mapData; s.updatedAt = Date.now(); saveMetadataDebounced?.(); } },
    GET_SETTINGS: sendSettingsToFrame,
    SAVE_SETTINGS: handleSaveSettings,
    SAVE_PROMPTS: handleSavePrompts,
    SAVE_CONTACTS: handleSaveContacts,
    SAVE_ALL_DATA: handleSaveAllData,
    FETCH_MODELS: handleFetchModels,
    TEST_CONNECTION: handleTestConnection,
    CHECK_WORLDBOOK_UID: handleCheckWorldbookUid,
    SEND_SMS: handleSendSms,
    LOAD_SMS_HISTORY: handleLoadSmsHistory,
    SAVE_SMS_HISTORY: handleSaveSmsHistory,
    COMPRESS_SMS: handleCompressSms,
    CHECK_STRANGER_WORLDBOOK: handleCheckStrangerWorldbook,
    GENERATE_NPC: handleGenerateNpc,
    EXTRACT_STRANGERS: handleExtractStrangers,
    SCENE_SWITCH: handleSceneSwitch,
    EXECUTE_SLASH_COMMAND: handleExecuteSlashCommand,
    SEND_INVITE: handleSendInvite,
    GENERATE_WORLD: handleGenerateWorld,
    SIMULATE_WORLD: handleSimulateWorld
};

function handleFrameMessage({ data }) {
    if (data?.source !== "LittleWhiteBox-OutlineFrame") return;
    handlers[data.type]?.(data);
}

// ================== 通用指针交互 ==================
function setupPointerDrag(el, { onStart, onMove, onEnd, shouldHandle }) {
    if (!el) return;
    let state = null;
    
    el.addEventListener('pointerdown', e => {
        if (shouldHandle && !shouldHandle()) return;
        e.preventDefault(); e.stopPropagation();
        state = onStart(e);
        state.pointerId = e.pointerId;
        el.setPointerCapture(e.pointerId);
    });
    
    el.addEventListener('pointermove', e => state && onMove(e, state));
    
    const end = () => { if (!state) return; onEnd?.(state); try { el.releasePointerCapture(state.pointerId); } catch {} state = null; };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(evt => el.addEventListener(evt, end));
}

// ================== Overlay ==================
function createOverlay() {
    if (overlayCreated) return;
    overlayCreated = true;

    document.body.appendChild($(buildOverlayHtml(iframePath))[0]);

    const overlay = document.getElementById("xiaobaix-story-outline-overlay");
    const wrap = overlay.querySelector(".xb-so-frame-wrap");
    const iframe = overlay.querySelector("iframe");
    const setPtr = v => iframe && (iframe.style.pointerEvents = v);

    setupPointerDrag(overlay.querySelector(".xb-so-drag-handle"), {
        shouldHandle: () => !isMobile(),
        onStart(e) {
            const r = wrap.getBoundingClientRect(), ro = overlay.getBoundingClientRect();
            wrap.style.left = (r.left - ro.left) + 'px'; wrap.style.top = (r.top - ro.top) + 'px'; wrap.style.transform = '';
            setPtr('none');
            return { sx: e.clientX, sy: e.clientY, sl: parseFloat(wrap.style.left), st: parseFloat(wrap.style.top) };
        },
        onMove(e, s) {
            wrap.style.left = Math.max(0, Math.min(overlay.clientWidth - wrap.offsetWidth, s.sl + e.clientX - s.sx)) + 'px';
            wrap.style.top = Math.max(0, Math.min(overlay.clientHeight - wrap.offsetHeight, s.st + e.clientY - s.sy)) + 'px';
        },
        onEnd: () => setPtr('')
    });

    setupPointerDrag(overlay.querySelector(".xb-so-resize-handle"), {
        shouldHandle: () => !isMobile(),
        onStart(e) {
            const r = wrap.getBoundingClientRect(), ro = overlay.getBoundingClientRect();
            wrap.style.left = (r.left - ro.left) + 'px'; wrap.style.top = (r.top - ro.top) + 'px'; wrap.style.transform = '';
            setPtr('none');
            return { sx: e.clientX, sy: e.clientY, sw: wrap.offsetWidth, sh: wrap.offsetHeight, ratio: wrap.offsetWidth / wrap.offsetHeight };
        },
        onMove(e, s) {
            const dx = e.clientX - s.sx, dy = e.clientY - s.sy;
            const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy * s.ratio;
            let w = Math.max(400, Math.min(window.innerWidth * 0.95, s.sw + delta));
            let h = w / s.ratio;
            if (h > window.innerHeight * 0.9) { h = window.innerHeight * 0.9; w = h * s.ratio; }
            if (h < 300) { h = 300; w = h * s.ratio; }
            wrap.style.width = w + 'px'; wrap.style.height = h + 'px';
        },
        onEnd: () => setPtr('')
    });

    setupPointerDrag(overlay.querySelector(".xb-so-resize-mobile"), {
        shouldHandle: () => isMobile(),
        onStart(e) { setPtr('none'); return { sy: e.clientY, sh: wrap.offsetHeight }; },
        onMove(e, s) { wrap.style.height = Math.max(200, Math.min(window.innerHeight * 0.9, s.sh + e.clientY - s.sy)) + 'px'; },
        onEnd: () => setPtr('')
    });

    window.addEventListener("message", handleFrameMessage);
}

function updateLayout() {
    const wrap = document.querySelector(".xb-so-frame-wrap");
    if (!wrap) return;
    const drag = document.querySelector(".xb-so-drag-handle");
    const resize = document.querySelector(".xb-so-resize-handle");
    const mobile = document.querySelector(".xb-so-resize-mobile");

    if (isMobile()) {
        if (drag) drag.style.display = 'none';
        if (resize) resize.style.display = 'none';
        if (mobile) mobile.style.display = 'flex';
        wrap.style.cssText = MOBILE_LAYOUT_STYLE;
    } else {
        if (drag) drag.style.display = 'block';
        if (resize) resize.style.display = 'block';
        if (mobile) mobile.style.display = 'none';
        wrap.style.cssText = DESKTOP_LAYOUT_STYLE;
    }
}

function showOverlay() {
    if (!overlayCreated) createOverlay();
    frameReady = false;
    const iframe = document.getElementById("xiaobaix-story-outline-iframe");
    if (iframe) iframe.src = iframePath;
    updateLayout();
    $("#xiaobaix-story-outline-overlay").show();
}

function hideOverlay() { $("#xiaobaix-story-outline-overlay").hide(); }

$(window).on('resize', () => { if ($("#xiaobaix-story-outline-overlay").is(':visible')) updateLayout(); });

// ================== 楼层按钮 ==================
function addOutlineBtnToMessage(mesId) {
    if (!getSettings().storyOutline?.enabled) return;
    const msg = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!msg || msg.querySelector('.xiaobaix-story-outline-btn')) return;

    const btn = document.createElement('div');
    btn.className = 'mes_btn xiaobaix-story-outline-btn';
    btn.title = '剧情地图';
    btn.dataset.mesid = mesId;
    btn.innerHTML = '<i class="fa-regular fa-map"></i>';
    btn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        if (!getSettings().storyOutline?.enabled) return;
        currentMesId = Number(mesId);
        showOverlay();
        loadAndSendMapData();
    });

    if (window.registerButtonToSubContainer?.(mesId, btn)) return;
    msg.querySelector('.flex-container.flex1.alignitemscenter')?.appendChild(btn);
}

function initButtons() {
    if (!getSettings().storyOutline?.enabled) return;
    $("#chat .mes").each((_, el) => { const id = el.getAttribute("mesid"); if (id != null) addOutlineBtnToMessage(id); });
}

// ================== 事件 ==================
function registerEvents() {
    initButtons();
    
    // 聊天切换时：初始化按钮 + 注入剧情大纲
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(initButtons, 80);
        setTimeout(injectStoryOutlineToChat, 100); // 聊天切换后重新注入
    });
    
    // 消息生成开始前：确保剧情大纲已注入
    eventSource.on(event_types.GENERATION_STARTED, () => {
        injectStoryOutlineToChat();
    });

    const btnHandler = data => setTimeout(() => {
        const id = data?.element ? $(data.element).attr("mesid") : data?.messageId;
        id == null ? initButtons() : addOutlineBtnToMessage(id);
    }, 50);

    [event_types.USER_MESSAGE_RENDERED, event_types.CHARACTER_MESSAGE_RENDERED, event_types.MESSAGE_RECEIVED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_EDITED].forEach(t => eventSource.on(t, btnHandler));

    $(document).on("xiaobaix:storyOutline:toggle", (_e, enabled) => {
        if (enabled) {
            initButtons();
            injectStoryOutlineToChat(); // 启用时注入
        } else {
            $(".xiaobaix-story-outline-btn").remove();
            hideOverlay();
            // 禁用时清除注入
            setExtensionPrompt(STORY_OUTLINE_MODULE, '', extension_prompt_types.IN_CHAT, 0);
        }
    });
    
    document.addEventListener('xiaobaixEnabledChanged', e => {
        if (e?.detail?.enabled) {
            if (getSettings().storyOutline?.enabled) {
                initButtons();
                injectStoryOutlineToChat(); // 主扩展启用时注入
            }
        } else {
            $(".xiaobaix-story-outline-btn").remove();
            hideOverlay();
            // 主扩展禁用时清除注入
            setExtensionPrompt(STORY_OUTLINE_MODULE, '', extension_prompt_types.IN_CHAT, 0);
        }
    });
}

// ================== 清理/初始化 ==================
function cleanup() {
    $(".xiaobaix-story-outline-btn").remove();
    hideOverlay();
    overlayCreated = false;
    frameReady = false;
    pendingFrameMessages = [];
    window.removeEventListener("message", handleFrameMessage);
    document.getElementById("xiaobaix-story-outline-overlay")?.remove();
    
    // 清理时清除注入
    setExtensionPrompt(STORY_OUTLINE_MODULE, '', extension_prompt_types.IN_CHAT, 0);
}

jQuery(() => {
    if (!getSettings().storyOutline?.enabled) return;
    registerEvents();
    
    // 初始化时立即尝试注入（如果已有聊天数据）
    setTimeout(injectStoryOutlineToChat, 200);
    
    window.registerModuleCleanup?.('storyOutline', cleanup);
});

export { cleanup };
