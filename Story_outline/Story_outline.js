import { extension_settings, saveMetadataDebounced } from "../../../../extensions.js";
import { eventSource, event_types, chat_metadata, name1 } from "../../../../../script.js";
import { promptManager } from "../../../../openai.js";
import { loadWorldInfo, saveWorldInfo, world_names, world_info } from "../../../../world-info.js";
import { getContext } from "../../../../st-context.js";
import { streamingGeneration } from "../streaming-generation.js";
import { 
    buildSmsMessages,
    buildSummaryMessages,
    buildSmsHistoryContent,
    buildExistingSummaryContent,
    buildNpcGenerationMessages,
    formatNpcToWorldbookContent,
    buildExtractStrangersMessages,
    buildWorldGenMessages,
    buildWorldSimMessages,
    buildSceneSwitchMessages,
    buildInviteMessages,
    buildOverlayHtml,
    MOBILE_LAYOUT_STYLE,
    DESKTOP_LAYOUT_STYLE
} from "./story-outline-prompt.js";

const EXT_ID = "LittleWhiteBox";
const iframePath = `scripts/extensions/third-party/${EXT_ID}/Story_outline/Story_outline.html`;
const OUTLINE_IDENTIFIER = "storyOutline";

let overlayCreated = false, frameReady = false, currentMesId = null, pendingFrameMessages = [];
let outlinePromptInjected = false;

// ================== 工具 ==================
function getSettings() {
    const ext = extension_settings[EXT_ID] ||= {};
    ext.storyOutline ||= { enabled: true };
    return ext;
}

function getOutlineStore() {
    if (!chat_metadata) return null;
    chat_metadata.extensions ||= {};
    chat_metadata.extensions[EXT_ID] ||= {};
    chat_metadata.extensions[EXT_ID].storyOutline ||= { 
        mapData: null,
        stage: 0,
        deviationScore: 0,
        outlineData: {
            meta: null,
            timeline: null,
            world: null,
            outdoor: null,
            indoor: null,
            sceneSetup: null,
            strangers: null,
            contacts: null
        },
        dataChecked: {
            meta: false,
            timeline: false,
            world: false,
            outdoor: false,
            indoor: false,
            sceneSetup: false,
            strangers: false,
            contacts: false
        }
    };
    return chat_metadata.extensions[EXT_ID].storyOutline;
}

// ================== 全局设置（本地存储） ==================
const GLOBAL_SETTINGS_KEY = 'LittleWhiteBox_StoryOutline_GlobalSettings';
const COMM_SETTINGS_KEY = 'LittleWhiteBox_StoryOutline_CommSettings';

function getGlobalSettings() {
    try {
        const stored = localStorage.getItem(GLOBAL_SETTINGS_KEY);
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (e) {
        console.error('[Story Outline] Failed to load global settings:', e);
    }
    return { apiUrl: '', apiKey: '', model: '' };
}

function saveGlobalSettings(settings) {
    try {
        localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('[Story Outline] Failed to save global settings:', e);
    }
}

function getCommSettings() {
    try {
        const stored = localStorage.getItem(COMM_SETTINGS_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            // 确保 historyCount 有默认值
            if (typeof parsed.historyCount !== 'number') {
                parsed.historyCount = 50;
            }
            return parsed;
        }
    } catch (e) {
        console.error('[Story Outline] Failed to load comm settings:', e);
    }
    return { historyCount: 50, npcPosition: 0, npcOrder: 100 };
}

function saveCommSettings(settings) {
    try {
        localStorage.setItem(COMM_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('[Story Outline] Failed to save comm settings:', e);
    }
}

/**
 * 使用自定义 API 或酒馆 API 调用 LLM
 * @param {string|Array} promptOrMessages - 提示词字符串或消息数组
 * @param {boolean} useRaw - 是否使用 raw 模式（不带预设）
 * @returns {Promise<string>} - 生成的回复
 */
async function callLLM(promptOrMessages, useRaw = false) {
    const settings = getGlobalSettings();
    const { apiUrl, apiKey, model } = settings;
    
    // 构建 API 选项
    const apiOptions = {
        as: 'user',
        nonstream: 'true'
    };
    
    // 如果设置了自定义 API，添加到选项中
    if (apiUrl && apiUrl.trim()) {
        console.log('[Story Outline] Using custom API:', apiUrl);
        apiOptions.api = 'openai';  // 使用 openai 兼容格式
        apiOptions.apiurl = apiUrl.trim();
        if (apiKey) {
            apiOptions.apipassword = apiKey;
        }
        if (model) {
            apiOptions.model = model;
        }
    } else {
        console.log('[Story Outline] Using SillyTavern default API');
    }
    
    // 执行生成
    let result;
    if (useRaw) {
        // raw 模式：检查是否传入消息数组
        if (Array.isArray(promptOrMessages)) {
            // 将消息数组转换为 xbgenraw 的 top 参数格式: role=content;role2=content2
            const topParam = promptOrMessages.map(m => {
                const role = m.role === 'system' ? 'sys' : m.role;
                // 将内容中的分号和等号进行转义处理（用花括号包裹）
                const content = `{${m.content}}`;
                return `${role}=${content}`;
            }).join(';');
            apiOptions.top = topParam;
            result = await streamingGeneration.xbgenrawCommand(apiOptions, '');
        } else {
            result = await streamingGeneration.xbgenrawCommand(apiOptions, promptOrMessages);
        }
    } else {
        apiOptions.position = 'history';
        apiOptions.lock = 'on';
        result = await streamingGeneration.xbgenCommand(apiOptions, promptOrMessages);
    }
    return String(result || '').trim();
}

const isMobile = () => window.innerWidth <= 768;

// ================== Prompt Manager 集成 ==================

/**
 * 根据当前 stage 获取应显示的洋葱层级（L级真相机制）
 * stage=0: L1, L2
 * stage=1: L1, L2, L3
 * stage=2: L2, L3, L4
 * stage=3: L3, L4, L5
 * stage=4: L4, L5, L6
 * stage>=5: L5, L6, L7
 */
function getVisibleOnionLayers(stage) {
    if (stage === 0) return ['L1_Surface', 'L2_Traces'];
    if (stage === 1) return ['L1_Surface', 'L2_Traces', 'L3_Mechanism'];
    if (stage === 2) return ['L2_Traces', 'L3_Mechanism', 'L4_Nodes'];
    if (stage === 3) return ['L3_Mechanism', 'L4_Nodes', 'L5_Core'];
    if (stage === 4) return ['L4_Nodes', 'L5_Core', 'L6_Drive'];
    return ['L5_Core', 'L6_Drive', 'L7_Consequence'];  // stage >= 5
}

/**
 * 将 outlineData 格式化为提示词文本（根据 dataChecked 选择性包含）
 * 按新规则筛选显示内容（L级洋葱层机制）
 */
function formatMapDataAsPrompt() {
    const store = getOutlineStore();
    if (!store) return "";
    
    const { outlineData, dataChecked } = store;
    if (!outlineData) return "";
    
    let text = "[Story Outline - 剧情地图数据]\n\n";
    let hasContent = false;
    
    // 获取当前 stage（从 store 中读取，用户可在设置中调整）
    const currentStage = store.stage ?? 0;
    
    // 1. 大纲（meta）- 显示 overview 和按 stage 筛选的洋葱层
    if (dataChecked?.meta && outlineData.meta) {
        hasContent = true;
        text += "【大纲】\n";
        text += "(注意：以下信息是目前世界可呈现给玩家的全部认知，玩家获取信息的困难度按层级递增。**严禁**引入任何未在此列表中出现的更深层级真相。如果遇到未解之谜，请保持神秘感。)\n\n";
        
        if (outlineData.meta.truth?.overview) {
            text += `核心真相（绝密）: ${outlineData.meta.truth.overview}\n\n`;
        }
        
        // 按 stage 筛选洋葱层级
        const visibleLayers = getVisibleOnionLayers(currentStage);
        const onion = outlineData.meta.truth?.onion_layers;
        if (onion) {
            text += "当前可呈现的层级:\n";
            visibleLayers.forEach(layerKey => {
                const layer = onion[layerKey];
                if (!layer) return;
                
                const layerName = layerKey.replace('_', ' - ');
                if (Array.isArray(layer)) {
                    // L1-L4 是数组，统一使用 desc/logic
                    layer.forEach((item, i) => {
                        text += `- [${layerName}${i+1}] ${item.desc}: ${item.logic}\n`;
                    });
                } else {
                    // L5-L7 是对象，统一使用 desc/logic
                    text += `- [${layerName}] ${layer.desc}: ${layer.logic}\n`;
                }
            });
            text += "\n";
        }
        
        // 显示结局信息
        if (outlineData.meta.outcomes) {
            text += "可能结局:\n";
            if (outlineData.meta.outcomes.default_end) {
                text += `- 默认结局: ${outlineData.meta.outcomes.default_end}\n`;
            }
            if (outlineData.meta.outcomes.intervention_end) {
                text += `- 介入结局: ${outlineData.meta.outcomes.intervention_end}\n`;
            }
            if (outlineData.meta.outcomes.resolution_end) {
                text += `- 解决结局: ${outlineData.meta.outcomes.resolution_end}\n`;
            }
            text += "\n";
        }
    }
    
    // 2. 时间线（timeline）- 仅显示当前 stage 的 state 和 event
    if (dataChecked?.timeline && outlineData.timeline?.length) {
        hasContent = true;
        const currentTimeline = outlineData.timeline.find(t => t.stage === currentStage);
        if (currentTimeline) {
            text += "【当前时间线】\n";
            text += `阶段: ${currentTimeline.stage}\n`;
            if (currentTimeline.state) text += `状态: ${currentTimeline.state}\n`;
            if (currentTimeline.event) text += `事件: ${currentTimeline.event}\n`;
            text += "\n";
        }
    }
    
    // 3. 大地图（outdoor）- 仅显示 description
    if (dataChecked?.outdoor && outlineData.outdoor?.description) {
        hasContent = true;
        text += "【大地图】\n";
        text += `${outlineData.outdoor.description}\n\n`;
    }
    
    // 4. 局部地图（indoor）- 仅显示 description
    if (dataChecked?.indoor && outlineData.indoor?.description) {
        hasContent = true;
        text += "【局部地图】\n";
        text += `${outlineData.indoor.description}\n\n`;
    }
    
    // 5. 世界资讯（news）- 仅显示 title 和 content
    if (dataChecked?.world && outlineData.world?.news?.length) {
        hasContent = true;
        text += "【世界资讯】\n";
        outlineData.world.news.forEach(n => {
            text += `- ${n.title}: ${n.content}\n`;
        });
        text += "\n";
    }
    
    // 6. 联络人 - 仅显示 name, location, info
    if (dataChecked?.contacts && outlineData.contacts?.length) {
        hasContent = true;
        text += "【联络人】\n";
        outlineData.contacts.forEach(p => {
            text += `- ${p.name}`;
            if (p.location) text += ` (${p.location})`;
            if (p.info) text += `: ${p.info}`;
            text += "\n";
        });
        text += "\n";
    }
    
    // 7. 陌路人 - 仅显示 name, location, info
    if (dataChecked?.strangers && outlineData.strangers?.length) {
        hasContent = true;
        text += "【陌路人】\n";
        outlineData.strangers.forEach(p => {
            text += `- ${p.name}`;
            if (p.location) text += ` (${p.location})`;
            if (p.info) text += `: ${p.info}`;
            text += "\n";
        });
        text += "\n";
    }
    
    return hasContent ? text.trim() : "";
}

/**
 * 注入 outline prompt 条目到 PromptManager
 */
function injectOutlinePrompt() {
    if (outlinePromptInjected || !promptManager?.serviceSettings) return;
    
    const prompts = promptManager.serviceSettings.prompts;
    const promptOrder = promptManager.serviceSettings.prompt_order;
    
    // 检查是否已存在
    if (prompts.some(p => p?.identifier === OUTLINE_IDENTIFIER)) {
        outlinePromptInjected = true;
        return;
    }
    
    // 添加 prompt 定义（不是 marker，这样才有编辑和开关按钮）
    prompts.push({
        identifier: OUTLINE_IDENTIFIER,
        name: "Story Outline",
        system_prompt: false,  // 普通 prompt，可编辑和开关
        marker: false,
        role: "system",
        content: "",
        injection_position: 0,  // 相对位置（按预设顺序）
    });
    
    // 在每个角色的 prompt_order 中添加条目（放在 worldInfoBefore 上面）
    promptOrder.forEach(orderEntry => {
        if (!orderEntry?.order) return;
        const order = orderEntry.order;
        
        // 检查是否已存在
        if (order.some(e => e?.identifier === OUTLINE_IDENTIFIER)) return;
        
        // 找到 worldInfoBefore 的位置
        const wibIndex = order.findIndex(e => e?.identifier === "worldInfoBefore");
        const insertIndex = wibIndex !== -1 ? wibIndex : 0;
        
        // 插入
        order.splice(insertIndex, 0, {
            identifier: OUTLINE_IDENTIFIER,
            enabled: true,
        });
    });
    
    outlinePromptInjected = true;
    
    // 刷新 PromptManager 显示
    promptManager.render?.(false);
    
    console.log("[Story Outline] Prompt entry injected into PromptManager");
}

/**
 * 从 PromptManager 移除 outline prompt 条目
 */
function removeOutlinePrompt() {
    if (!promptManager?.serviceSettings) return;
    
    const prompts = promptManager.serviceSettings.prompts;
    const promptOrder = promptManager.serviceSettings.prompt_order;
    
    // 从 prompts 中移除
    const promptIndex = prompts.findIndex(p => p?.identifier === OUTLINE_IDENTIFIER);
    if (promptIndex !== -1) {
        prompts.splice(promptIndex, 1);
    }
    
    // 从每个角色的 prompt_order 中移除
    promptOrder.forEach(orderEntry => {
        if (!orderEntry?.order) return;
        const order = orderEntry.order;
        const orderIndex = order.findIndex(e => e?.identifier === OUTLINE_IDENTIFIER);
        if (orderIndex !== -1) {
            order.splice(orderIndex, 1);
        }
    });
    
    outlinePromptInjected = false;
    
    // 刷新 PromptManager 显示
    promptManager.render?.(false);
    
    console.log("[Story Outline] Prompt entry removed from PromptManager");
}

/**
 * 在生成前更新 outline prompt 的内容
 */
function updateOutlinePromptContent() {
    if (!promptManager?.serviceSettings) return;
    
    const prompt = promptManager.serviceSettings.prompts.find(p => p?.identifier === OUTLINE_IDENTIFIER);
    if (!prompt) {
        console.log("[Story Outline] Prompt not found, injecting...");
        injectOutlinePrompt();
        return updateOutlinePromptContent();  // 重试
    }
    
    // 获取当前地图数据并格式化
    const content = formatMapDataAsPrompt();
    prompt.content = content;
    
    console.log("[Story Outline] Updated prompt content:", content ? content.substring(0, 100) + "..." : "(empty)");
}

// ================== iframe通讯 ==================
function postToFrame(payload) {
    const iframe = document.getElementById("xiaobaix-story-outline-iframe");
    if (!iframe?.contentWindow || !frameReady) {
        pendingFrameMessages.push(payload);
        return;
    }
    iframe.contentWindow.postMessage({ source: "LittleWhiteBox", ...payload }, "*");
}

function flushPendingMessages() {
    if (!frameReady) return;
    const iframe = document.getElementById("xiaobaix-story-outline-iframe");
    if (!iframe?.contentWindow) return;
    pendingFrameMessages.forEach(p => 
        iframe.contentWindow.postMessage({ source: "LittleWhiteBox", ...p }, "*")
    );
    pendingFrameMessages = [];
}

function handleFrameMessage({ data }) {
    if (data?.source !== "LittleWhiteBox-OutlineFrame") return;
    
    console.log('[Story Outline] Received message from iframe:', data.type);
    
    switch (data.type) {
        case "FRAME_READY":
            frameReady = true;
            flushPendingMessages();
            loadAndSendMapData();
            break;
        case "CLOSE_PANEL":
            hideOverlay();
            break;
        case "SAVE_MAP_DATA":
            if (data.mapData) {
                const store = getOutlineStore();
                if (store) {
                    store.mapData = data.mapData;
                    store.updatedAt = Date.now();
                    saveMetadataDebounced?.();
                }
            }
            break;
        case "GET_SETTINGS":
            sendSettingsToFrame();
            break;
        case "SAVE_SETTINGS":
            handleSaveSettings(data);
            break;
        case "SAVE_CONTACTS":
            handleSaveContacts(data);
            break;
        case "SAVE_ALL_DATA":
            handleSaveAllData(data);
            break;
        case "FETCH_MODELS":
            handleFetchModels(data);
            break;
        case "TEST_CONNECTION":
            handleTestConnection(data);
            break;
        case "CHECK_WORLDBOOK_UID":
            handleCheckWorldbookUid(data);
            break;
        case "SEND_SMS":
            handleSendSms(data);
            break;
        case "LOAD_SMS_HISTORY":
            handleLoadSmsHistory(data);
            break;
        case "SAVE_SMS_HISTORY":
            handleSaveSmsHistory(data);
            break;
        case "COMPRESS_SMS":
            handleCompressSms(data);
            break;
        case "CHECK_STRANGER_WORLDBOOK":
            handleCheckStrangerWorldbook(data);
            break;
        case "GENERATE_NPC":
            handleGenerateNpc(data);
            break;
        case "EXTRACT_STRANGERS":
            handleExtractStrangers(data);
            break;
        case "SCENE_SWITCH":
            handleSceneSwitch(data);
            break;
        case "EXECUTE_SLASH_COMMAND":
            handleExecuteSlashCommand(data);
            break;
        case "SEND_INVITE":
            handleSendInvite(data);
            break;
        case "GENERATE_WORLD":
            handleGenerateWorld(data);
            break;
        case "SIMULATE_WORLD":
            handleSimulateWorld(data);
            break;
        case "SAVE_PROMPT_TEMPLATES":
            handleSavePromptTemplates(data);
            break;
    }
}

function sendSettingsToFrame() {
    const store = getOutlineStore();
    const globalSettings = getGlobalSettings();
    const commSettings = getCommSettings();
    console.log('[Story Outline] Sending settings to frame:', { 
        hasGlobalSettings: !!globalSettings,
        hasCommSettings: !!commSettings,
        stage: store?.stage,
        deviationScore: store?.deviationScore,
        dataChecked: store?.dataChecked,
        hasOutlineData: !!store?.outlineData
    });
    postToFrame({
        type: "LOAD_SETTINGS",
        globalSettings,
        commSettings,
        stage: store?.stage ?? 0,
        deviationScore: store?.deviationScore ?? 0,
        dataChecked: store?.dataChecked || {},
        outlineData: store?.outlineData || {}
    });
}

function handleSaveSettings(data) {
    console.log('[Story Outline] Saving settings...', {
        hasGlobalSettings: !!data.globalSettings,
        hasCommSettings: !!data.commSettings,
        dataChecked: data.dataChecked,
        hasAllData: !!data.allData
    });
    
    // 保存全局设置到本地存储
    if (data.globalSettings) {
        saveGlobalSettings(data.globalSettings);
        console.log('[Story Outline] Global settings saved to localStorage');
    }
    
    // 保存通讯设置到本地存储
    if (data.commSettings) {
        saveCommSettings(data.commSettings);
        console.log('[Story Outline] Comm settings saved to localStorage');
    }
    
    // 保存数据到聊天元数据
    const store = getOutlineStore();
    if (store) {
        // 保存 stage 和 deviationScore
        if (data.stage !== undefined) {
            store.stage = data.stage;
        }
        if (data.deviationScore !== undefined) {
            store.deviationScore = data.deviationScore;
        }
        if (data.dataChecked) {
            store.dataChecked = data.dataChecked;
        }
        if (data.allData) {
            store.outlineData = data.allData;
        }
        store.updatedAt = Date.now();
        saveMetadataDebounced?.();
        console.log('[Story Outline] Chat metadata saved');
        
        // 更新 prompt 内容
        updateOutlinePromptContent();
    }
}

/**
 * 保存提示词模板到本地存储
 */
function handleSavePromptTemplates(data) {
    if (data.promptTemplates) {
        localStorage.setItem('storyOutline_promptTemplates', JSON.stringify(data.promptTemplates));
        console.log('[Story Outline] Prompt templates saved to localStorage');
    }
}

/**
 * 获取提示词模板
 */
function getPromptTemplates() {
    try {
        const saved = localStorage.getItem('storyOutline_promptTemplates');
        return saved ? JSON.parse(saved) : null;
    } catch {
        return null;
    }
}

/**
 * 保存联络人数据到聊天元数据
 */
function handleSaveContacts(data) {
    const store = getOutlineStore();
    if (!store) return;
    
    // 初始化 outlineData 如果不存在
    if (!store.outlineData) {
        store.outlineData = {};
    }
    
    // 保存联络人数据
    if (data.contacts) {
        store.outlineData.contacts = data.contacts;
    }
    if (data.strangers) {
        store.outlineData.strangers = data.strangers;
    }
    
    store.updatedAt = Date.now();
    saveMetadataDebounced?.();
    console.log('[Story Outline] Contacts saved to chat metadata');
}

/**
 * 保存所有数据到聊天元数据（设置编辑后调用）
 */
function handleSaveAllData(data) {
    const store = getOutlineStore();
    if (!store) return;
    
    if (data.allData) {
        store.outlineData = data.allData;
    }
    
    store.updatedAt = Date.now();
    saveMetadataDebounced?.();
    console.log('[Story Outline] All data saved to chat metadata');
    
    // 更新 prompt 内容
    updateOutlinePromptContent();
}

async function handleFetchModels(data) {
    const { apiUrl, apiKey } = data;
    console.log('[Story Outline] Fetching models...', { apiUrl: apiUrl ? '(set)' : '(empty)', hasKey: !!apiKey });
    try {
        let url = apiUrl;
        if (!url) {
            // 使用酒馆自己的 API - 尝试多个可能的端点
            const endpoints = [
                '/api/backends/chat-completions/models',
                '/api/openai/models'
            ];
            for (const endpoint of endpoints) {
                try {
                    const resp = await fetch(endpoint, { headers: { 'Content-Type': 'application/json' } });
                    if (resp.ok) {
                        const json = await resp.json();
                        const models = (json.data || json || [])
                            .map(m => m.id || m.name || m)
                            .filter(m => typeof m === 'string');
                        if (models.length > 0) {
                            console.log('[Story Outline] Found models:', models.length);
                            postToFrame({ type: "FETCH_MODELS_RESULT", models });
                            return;
                        }
                    }
                } catch (e) {
                    console.log('[Story Outline] Endpoint failed:', endpoint, e.message);
                }
            }
            throw new Error('无法从酒馆获取模型列表');
        } else {
            // 使用外部 API
            url = url.replace(/\/$/, '') + '/models';
        }
        
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        
        const resp = await fetch(url, { headers });
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        
        const json = await resp.json();
        const models = (json.data || json || [])
            .map(m => m.id || m.name || m)
            .filter(m => typeof m === 'string');
        
        console.log('[Story Outline] Found models:', models.length);
        postToFrame({ type: "FETCH_MODELS_RESULT", models });
    } catch (e) {
        console.error('[Story Outline] Fetch models error:', e);
        postToFrame({ type: "FETCH_MODELS_RESULT", error: e.message });
    }
}

async function handleTestConnection(data) {
    const { apiUrl, apiKey, model } = data;
    console.log('[Story Outline] Testing connection...', { apiUrl: apiUrl ? '(set)' : '(empty)', hasKey: !!apiKey, model });
    try {
        let url = apiUrl;
        if (!url) {
            // 使用酒馆自己的 API - 测试多个端点
            const endpoints = [
                '/api/backends/chat-completions/status',
                '/api/openai/models',
                '/api/backends/chat-completions/models'
            ];
            for (const endpoint of endpoints) {
                try {
                    const resp = await fetch(endpoint, { headers: { 'Content-Type': 'application/json' } });
                    if (resp.ok) {
                        console.log('[Story Outline] Connection test success via:', endpoint);
                        postToFrame({ 
                            type: "TEST_CONN_RESULT", 
                            success: true, 
                            message: `连接成功${model ? ` (模型: ${model})` : ''}`
                        });
                        return;
                    }
                } catch (e) {
                    console.log('[Story Outline] Endpoint failed:', endpoint);
                }
            }
            throw new Error('无法连接到酒馆API');
        } else {
            url = url.replace(/\/$/, '') + '/models';
        }
        
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        
        const resp = await fetch(url, { headers });
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        
        console.log('[Story Outline] Connection test success');
        postToFrame({ 
            type: "TEST_CONN_RESULT", 
            success: true, 
            message: `连接成功${model ? ` (模型: ${model})` : ''}` 
        });
    } catch (e) {
        console.error('[Story Outline] Connection test error:', e);
        postToFrame({ 
            type: "TEST_CONN_RESULT", 
            success: false, 
            message: `连接失败: ${e.message}` 
        });
    }
}

/**
 * 处理检查世界书 UID 请求
 * 从角色卡绑定的世界书中查找指定 UID 的条目，获取其主要关键字
 */
async function handleCheckWorldbookUid(data) {
    const { uid, requestId } = data;
    console.log('[Story Outline] Checking worldbook UID:', uid);
    
    try {
        if (!uid || uid.trim() === '') {
            postToFrame({ 
                type: "CHECK_WORLDBOOK_UID_RESULT", 
                requestId,
                error: '请输入有效的UID' 
            });
            return;
        }
        
        const uidNumber = parseInt(uid, 10);
        if (isNaN(uidNumber)) {
            postToFrame({ 
                type: "CHECK_WORLDBOOK_UID_RESULT", 
                requestId,
                error: 'UID必须是数字' 
            });
            return;
        }
        
        // 获取当前角色卡绑定的世界书
        const ctx = getContext();
        const character = ctx.characters?.[ctx.characterId];
        
        if (!character) {
            postToFrame({ 
                type: "CHECK_WORLDBOOK_UID_RESULT", 
                requestId,
                error: '未找到当前角色卡' 
            });
            return;
        }
        
        // 获取角色卡绑定的主世界书
        const primaryBook = character.data?.extensions?.world;
        
        // 获取额外绑定的世界书
        const charLore = world_info?.charLore || [];
        const fileName = character.avatar;
        const extraEntry = charLore.find(e => e.name === fileName);
        const extraBooks = extraEntry?.extraBooks || [];
        
        // 合并所有要搜索的世界书
        const booksToSearch = [];
        if (primaryBook && world_names?.includes(primaryBook)) {
            booksToSearch.push(primaryBook);
        }
        if (extraBooks.length) {
            extraBooks.forEach(book => {
                if (world_names?.includes(book) && !booksToSearch.includes(book)) {
                    booksToSearch.push(book);
                }
            });
        }
        
        if (!booksToSearch.length) {
            postToFrame({ 
                type: "CHECK_WORLDBOOK_UID_RESULT", 
                requestId,
                error: '当前角色卡没有绑定世界书' 
            });
            return;
        }
        
        console.log('[Story Outline] Searching in worldbooks:', booksToSearch);
        
        // 在所有世界书中搜索指定 UID 的条目
        for (const bookName of booksToSearch) {
            const worldData = await loadWorldInfo(bookName);
            if (!worldData?.entries) continue;
            
            const entry = worldData.entries[uidNumber];
            if (entry) {
                // 找到了条目，获取主要关键字
                const primaryKeys = Array.isArray(entry.key) ? entry.key : [];
                
                if (!primaryKeys.length) {
                    postToFrame({ 
                        type: "CHECK_WORLDBOOK_UID_RESULT", 
                        requestId,
                        error: `在「${bookName}」中找到条目 UID ${uid}，但没有主要关键字` 
                    });
                    return;
                }
                
                console.log('[Story Outline] Found entry in', bookName, '- Primary keys:', primaryKeys);
                
                postToFrame({ 
                    type: "CHECK_WORLDBOOK_UID_RESULT", 
                    requestId,
                    primaryKeys: primaryKeys,
                    worldbook: bookName,
                    comment: entry.comment || ''
                });
                return;
            }
        }
        
        // 未找到条目
        postToFrame({ 
            type: "CHECK_WORLDBOOK_UID_RESULT", 
            requestId,
            error: `在角色卡绑定的世界书中未找到 UID 为 ${uid} 的条目` 
        });
        
    } catch (e) {
        console.error('[Story Outline] Check worldbook UID error:', e);
        postToFrame({ 
            type: "CHECK_WORLDBOOK_UID_RESULT", 
            requestId,
            error: `查询出错: ${e.message}` 
        });
    }
}

/**
 * 查找联络人对应的世界书条目
 */
async function findWorldbookEntry(worldbookUid) {
    const ctx = getContext();
    const character = ctx.characters?.[ctx.characterId];
    if (!character) return null;
    
    const uidNumber = parseInt(worldbookUid, 10);
    if (isNaN(uidNumber)) return null;
    
    // 获取角色卡绑定的世界书
    const primaryBook = character.data?.extensions?.world;
    const charLore = world_info?.charLore || [];
    const fileName = character.avatar;
    const extraEntry = charLore.find(e => e.name === fileName);
    const extraBooks = extraEntry?.extraBooks || [];
    
    const booksToSearch = [];
    if (primaryBook && world_names?.includes(primaryBook)) {
        booksToSearch.push(primaryBook);
    }
    extraBooks.forEach(book => {
        if (world_names?.includes(book) && !booksToSearch.includes(book)) {
            booksToSearch.push(book);
        }
    });
    
    for (const bookName of booksToSearch) {
        const worldData = await loadWorldInfo(bookName);
        if (!worldData?.entries) continue;
        
        const entry = worldData.entries[uidNumber];
        if (entry) {
            return { bookName, entry, uidNumber, worldData };
        }
    }
    
    return null;
}

/**
 * 处理发送短信请求
 */
async function handleSendSms(data) {
    const { requestId, contactName, worldbookUid, userMessage, chatHistory, summarizedCount } = data;
    console.log('[Story Outline] Sending SMS:', { contactName, worldbookUid, userMessage, summarizedCount });
    
    try {
        const ctx = getContext();
        const userName = name1 || ctx.name1 || '用户';
        
        // 获取世界书条目（用于读取总结和角色设定）
        let characterContent = '';
        let existingSummaries = {};
        
        if (worldbookUid) {
            try {
                const entryResult = await findWorldbookEntry(worldbookUid);
                if (entryResult?.entry) {
                    const content = entryResult.entry.content || '';
                    
                    // 提取角色设定（排除 SMS_HISTORY 部分）
                    const smsMarker = '[SMS_HISTORY_START]';
                    const smsIdx = content.indexOf(smsMarker);
                    characterContent = smsIdx !== -1 ? content.substring(0, smsIdx).trim() : content;
                    
                    // 提取已有总结
                    const smsEndMarker = '[SMS_HISTORY_END]';
                    const startIdx = content.indexOf(smsMarker);
                    const endIdx = content.indexOf(smsEndMarker);
                    if (startIdx !== -1 && endIdx !== -1) {
                        const jsonStr = content.substring(startIdx + smsMarker.length, endIdx).trim();
                        try {
                            const parsed = JSON.parse(jsonStr);
                            if (Array.isArray(parsed)) {
                                const summaryItem = parsed.find(item => typeof item === 'string' && item.startsWith('SMS_summary:'));
                                if (summaryItem) {
                                    existingSummaries = JSON.parse(summaryItem.substring('SMS_summary:'.length));
                                }
                            }
                        } catch {}
                    }
                    
                    console.log('[Story Outline] Found character content and summaries for:', contactName);
                }
            } catch (e) {
                console.warn('[Story Outline] Failed to get worldbook entry:', e);
            }
        }
        
        // 构建历史文本：总结 + 未总结的消息
        let historyText = '';
        const sc = summarizedCount || 0;
        
        // 添加总结部分
        const summaryKeys = Object.keys(existingSummaries).filter(k => k !== '_count').sort((a, b) => parseInt(a) - parseInt(b));
        if (summaryKeys.length > 0) {
            const summaryText = summaryKeys.map(k => existingSummaries[k]).join('；');
            historyText = `[之前的对话摘要] ${summaryText}\n\n`;
        }
        
        // 添加未总结的消息（从 summarizedCount 开始，不包括最后一条刚发的）
        if (chatHistory && chatHistory.length > 1) {
            const unsummarizedMsgs = chatHistory.slice(sc, -1);
            if (unsummarizedMsgs.length > 0) {
                historyText += unsummarizedMsgs.map(m => {
                    const speaker = m.type === 'sent' ? userName : contactName;
                    return `${speaker}：${m.text}`;
                }).join('\n');
            }
        }
        
        const commSettings = getCommSettings();
        
        // 使用默认结构：xbgenraw + 专门的消息格式
        const storyOutline = formatMapDataAsPrompt();
        const historyCount = commSettings.historyCount || 50;
        
        const smsHistoryContent = buildSmsHistoryContent(historyText);
        
        const messages = buildSmsMessages({
            contactName,
            userName,
            storyOutline,
            historyCount,
            smsHistoryContent,
            userMessage,
            characterContent
        });
        
        console.log('[Story Outline] SMS generation:', messages);
        
        const reply = await callLLM(messages, true);  // useRaw = true, 传递消息数组
        
        if (!reply) {
            postToFrame({
                type: 'SMS_RESULT',
                requestId,
                error: '生成回复失败，请重试'
            });
            return;
        }
        
        console.log('[Story Outline] SMS reply:', reply);
        
        postToFrame({
            type: 'SMS_RESULT',
            requestId,
            reply
        });
        
    } catch (e) {
        console.error('[Story Outline] SMS generation error:', e);
        postToFrame({
            type: 'SMS_RESULT',
            requestId,
            error: `生成失败: ${e.message}`
        });
    }
}

/**
 * 处理加载短信历史请求
 * 优先从聊天元数据读取（完整消息），否则从世界书读取（只有未总结的）
 */
async function handleLoadSmsHistory(data) {
    const { worldbookUid } = data;
    console.log('[Story Outline] Loading SMS history for UID:', worldbookUid);
    
    try {
        // 优先从聊天元数据读取（包含完整消息和 summarizedCount）
        const store = getOutlineStore();
        const contacts = store?.outlineData?.contacts || [];
        const contact = contacts.find(c => c.worldbookUid === worldbookUid);
        
        if (contact?.smsHistory?.messages?.length) {
            console.log('[Story Outline] Loaded SMS from chat metadata, messages:', contact.smsHistory.messages.length);
            postToFrame({
                type: 'LOAD_SMS_HISTORY_RESULT',
                worldbookUid,
                messages: contact.smsHistory.messages,
                summarizedCount: contact.smsHistory.summarizedCount || 0
            });
            return;
        }
        
        // 如果聊天元数据没有，从世界书读取（只有未总结的消息）
        const entryData = await findWorldbookEntry(worldbookUid);
        if (!entryData?.entry) {
            postToFrame({
                type: 'LOAD_SMS_HISTORY_RESULT',
                worldbookUid,
                messages: [],
                summarizedCount: 0
            });
            return;
        }
        
        const content = entryData.entry.content || '';
        const smsMarker = '[SMS_HISTORY_START]';
        const smsEndMarker = '[SMS_HISTORY_END]';
        
        let messages = [];
        const startIdx = content.indexOf(smsMarker);
        const endIdx = content.indexOf(smsEndMarker);
        
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            const jsonStr = content.substring(startIdx + smsMarker.length, endIdx).trim();
            try {
                const parsed = JSON.parse(jsonStr);
                if (Array.isArray(parsed)) {
                    parsed.forEach(item => {
                        if (typeof item === 'string') {
                            if (item.startsWith('SMS_summary:')) {
                                return; // 跳过总结
                            }
                            const colonIdx = item.indexOf(':');
                            if (colonIdx > 0) {
                                const speaker = item.substring(0, colonIdx);
                                const text = item.substring(colonIdx + 1);
                                const isUser = speaker === '{{user}}';
                                messages.push({ type: isUser ? 'sent' : 'received', text });
                            }
                        }
                    });
                }
            } catch (e) {
                console.warn('[Story Outline] Failed to parse SMS history:', e);
            }
        }
        
        console.log('[Story Outline] Loaded SMS from worldbook, messages:', messages.length);
        
        // 世界书只有未总结的消息，所以 summarizedCount = 0
        postToFrame({
            type: 'LOAD_SMS_HISTORY_RESULT',
            worldbookUid,
            messages,
            summarizedCount: 0
        });
        
    } catch (e) {
        console.error('[Story Outline] Load SMS history error:', e);
        postToFrame({
            type: 'LOAD_SMS_HISTORY_RESULT',
            worldbookUid,
            messages: [],
            summarizedCount: 0
        });
    }
}

/**
 * 处理保存短信历史请求
 * 只保存到世界书（聊天元数据由 saveContactsData 统一保存）
 * 世界书：总结 + 未总结的消息（精简存储）
 */
async function handleSaveSmsHistory(data) {
    const { worldbookUid, messages, contactName, summarizedCount } = data;
    console.log('[Story Outline] Saving SMS history to worldbook for UID:', worldbookUid, 'Messages:', messages?.length, 'Summarized:', summarizedCount);
    
    try {
        // 只保存到世界书（聊天元数据由 SAVE_CONTACTS 统一保存）
        const entryData = await findWorldbookEntry(worldbookUid);
        if (!entryData) {
            console.warn('[Story Outline] Entry not found for SMS save');
            return;
        }
        
        const { bookName, entry, worldData } = entryData;
        const charName = contactName || entry.key?.[0] || '角色';
        
        // 读取现有的总结
        let content = entry.content || '';
        const smsMarker = '[SMS_HISTORY_START]';
        const smsEndMarker = '[SMS_HISTORY_END]';
        
        let existingSummaryStr = '';
        const startIdx = content.indexOf(smsMarker);
        const endIdx = content.indexOf(smsEndMarker);
        
        if (startIdx !== -1 && endIdx !== -1) {
            const jsonStr = content.substring(startIdx + smsMarker.length, endIdx).trim();
            try {
                const parsed = JSON.parse(jsonStr);
                if (Array.isArray(parsed)) {
                    const summaryItem = parsed.find(item => typeof item === 'string' && item.startsWith('SMS_summary:'));
                    if (summaryItem) {
                        existingSummaryStr = summaryItem;
                    }
                }
            } catch {}
            
            content = content.substring(0, startIdx).trimEnd() + content.substring(endIdx + smsEndMarker.length);
        }
        
        // 世界书只保存未总结的消息（从 summarizedCount 开始）
        if (messages && messages.length > 0) {
            const sc = summarizedCount || 0;
            const unsummarizedMessages = messages.slice(sc);
            const simplified = unsummarizedMessages.map(m => {
                const speaker = m.type === 'sent' ? '{{user}}' : charName;
                return `${speaker}:${m.text}`;
            });
            
            const smsArray = existingSummaryStr ? [existingSummaryStr, ...simplified] : simplified;
            const smsJson = JSON.stringify(smsArray);
            content = content.trimEnd() + `\n\n${smsMarker}\n${smsJson}\n${smsEndMarker}`;
        }
        
        entry.content = content.trim();
        await saveWorldInfo(bookName, worldData);
        console.log('[Story Outline] SMS history saved to worldbook');
        
    } catch (e) {
        console.error('[Story Outline] Save SMS history error:', e);
    }
}

/**
 * 处理压缩短信历史请求
 * 使用AI总结新消息，已总结的内容作为前置事件提供给AI参考
 * 总结格式：SMS_summary:{"1":"第一次总结","2":"第二次总结",...,"_count":14}
 */
async function handleCompressSms(data) {
    const { requestId, worldbookUid, messages, contactName, summarizedCount } = data;
    const currentSummarizedCount = summarizedCount || 0;
    console.log('[Story Outline] Compressing SMS for:', contactName, 'Messages:', messages?.length, 'Current summarized:', currentSummarizedCount);
    
    try {
        const ctx = getContext();
        const userName = name1 || ctx.name1 || '用户';
        
        // 获取世界书条目
        const entryData = await findWorldbookEntry(worldbookUid);
        
        // 获取现有总结作为前置事件
        let existingSummaries = {};
        if (entryData?.entry) {
            const content = entryData.entry.content || '';
            const smsMarker = '[SMS_HISTORY_START]';
            const smsEndMarker = '[SMS_HISTORY_END]';
            const startIdx = content.indexOf(smsMarker);
            const endIdx = content.indexOf(smsEndMarker);
            
            if (startIdx !== -1 && endIdx !== -1) {
                const jsonStr = content.substring(startIdx + smsMarker.length, endIdx).trim();
                try {
                    const parsed = JSON.parse(jsonStr);
                    if (Array.isArray(parsed)) {
                        const summaryItem = parsed.find(item => typeof item === 'string' && item.startsWith('SMS_summary:'));
                        if (summaryItem) {
                            existingSummaries = JSON.parse(summaryItem.substring('SMS_summary:'.length));
                        }
                    }
                } catch {}
            }
        }
        
        // 找出需要总结的消息（保留最近几条不总结）
        const keepRecent = 4;
        const alreadySummarized = currentSummarizedCount || 0;
        const toSummarizeEnd = Math.max(alreadySummarized, messages.length - keepRecent);
        
        if (toSummarizeEnd <= alreadySummarized) {
            postToFrame({
                type: 'COMPRESS_SMS_RESULT',
                requestId,
                error: '没有足够的新消息需要总结'
            });
            return;
        }
        
        const messagesToSummarize = messages.slice(alreadySummarized, toSummarizeEnd);
        
        if (messagesToSummarize.length < 2) {
            postToFrame({
                type: 'COMPRESS_SMS_RESULT',
                requestId,
                error: '需要至少2条消息才能进行总结'
            });
            return;
        }
        
        // 构建对话文本（需要总结的新消息）
        const conversationText = messagesToSummarize.map(m => {
            const speaker = m.type === 'sent' ? userName : contactName;
            return `${speaker}：${m.text}`;
        }).join('\n');
        
        // 构建已有总结内容
        let existingSummaryText = '';
        const summaryKeys = Object.keys(existingSummaries).filter(k => k !== '_count').sort((a, b) => parseInt(a) - parseInt(b));
        if (summaryKeys.length > 0) {
            existingSummaryText = summaryKeys.map(k => `${k}. ${existingSummaries[k]}`).join('\n');
        }
        
        console.log('[Story Outline] Compress using default structure');
        
        // 重试机制：最多3次
        let summaryText = '';
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                // 使用默认结构：4 role 消息格式
                const existingSummaryContent = buildExistingSummaryContent(existingSummaryText);
                
                const messages = buildSummaryMessages({
                    existingSummaryContent,
                    conversationText
                });
                
                console.log('[Story Outline] Compress:', messages);
                const resultStr = await callLLM(messages, true);  // useRaw = true, 传递消息数组
                
                // 尝试提取 JSON
                let jsonMatch = resultStr.match(/\{[\s\S]*"summary"[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.summary && typeof parsed.summary === 'string') {
                        summaryText = parsed.summary.trim();
                        break;
                    }
                }
                
                // 如果没有匹配到 JSON，尝试直接解析
                try {
                    const parsed = JSON.parse(resultStr);
                    if (parsed.summary) {
                        summaryText = parsed.summary.trim();
                        break;
                    }
                } catch {}
                
                // JSON 解析失败，重试
                retryCount++;
                console.log(`[Story Outline] JSON parse failed, retry ${retryCount}/${maxRetries}`);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) {
                retryCount++;
                console.log(`[Story Outline] Generation error, retry ${retryCount}/${maxRetries}:`, e.message);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        
        if (!summaryText) {
            postToFrame({
                type: 'COMPRESS_SMS_RESULT',
                requestId,
                error: 'ECHO：总结生成出错，请重试'
            });
            return;
        }
        
        // 新的 summarizedCount
        const newSummarizedCount = toSummarizeEnd;
        
        console.log('[Story Outline] Summary generated:', summaryText, 'New summarizedCount:', newSummarizedCount);
        
        // 保存到世界书 - 只保留总结 + 未总结的消息（精简存储）
        if (entryData) {
            const { bookName, entry, worldData } = entryData;
            let content = entry.content || '';
            const charName = contactName || entry.key?.[0] || '角色';
            
            const smsMarker = '[SMS_HISTORY_START]';
            const smsEndMarker = '[SMS_HISTORY_END]';
            
            const startIdx = content.indexOf(smsMarker);
            const endIdx = content.indexOf(smsEndMarker);
            
            if (startIdx !== -1 && endIdx !== -1) {
                content = content.substring(0, startIdx).trimEnd() + content.substring(endIdx + smsEndMarker.length);
            }
            
            // 计算新的总结序号
            const existingKeys = Object.keys(existingSummaries).filter(k => k !== '_count').map(k => parseInt(k, 10)).filter(n => !isNaN(n));
            const nextKey = existingKeys.length > 0 ? Math.max(...existingKeys) + 1 : 1;
            
            // 添加新总结
            existingSummaries[String(nextKey)] = summaryText;
            
            // 世界书只保留未总结的消息（从 toSummarizeEnd 开始到末尾）
            const remainingMessages = messages.slice(toSummarizeEnd);
            const newMessages = remainingMessages.map(m => {
                const speaker = m.type === 'sent' ? '{{user}}' : charName;
                return `${speaker}:${m.text}`;
            });
            
            // 构建新的 SMS 历史数组：总结 + 未总结的消息
            const smsArray = [`SMS_summary:${JSON.stringify(existingSummaries)}`, ...newMessages];
            const smsJson = JSON.stringify(smsArray);
            
            content = content.trimEnd() + `\n\n${smsMarker}\n${smsJson}\n${smsEndMarker}`;
            
            entry.content = content.trim();
            await saveWorldInfo(bookName, worldData);
            console.log('[Story Outline] Summary saved to worldbook, remaining messages:', remainingMessages.length);
        }
        
        // 返回结果给 iframe（前端保留完整消息，只更新 summarizedCount）
        postToFrame({
            type: 'COMPRESS_SMS_RESULT',
            requestId,
            summary: summaryText,
            newSummarizedCount
        });
        
    } catch (e) {
        console.error('[Story Outline] Compress SMS error:', e);
        postToFrame({
            type: 'COMPRESS_SMS_RESULT',
            requestId,
            error: `压缩失败: ${e.message}`
        });
    }
}

/**
 * 检查陌路人名字是否匹配世界书条目的主要关键字
 * 如果匹配，返回该条目的 UID，省去 LLM 生成步骤
 */
async function handleCheckStrangerWorldbook(data) {
    const { requestId, strangerName } = data;
    console.log('[Story Outline] Checking worldbook for stranger:', strangerName);
    
    try {
        const ctx = getContext();
        const character = ctx.characters?.[ctx.characterId];
        
        if (!character) {
            postToFrame({
                type: 'CHECK_STRANGER_WORLDBOOK_RESULT',
                requestId,
                found: false
            });
            return;
        }
        
        // 获取角色卡绑定的世界书
        const primaryBook = character.data?.extensions?.world;
        const charLore = world_info?.charLore || [];
        const fileName = character.avatar;
        const extraEntry = charLore.find(e => e.name === fileName);
        const extraBooks = extraEntry?.extraBooks || [];
        
        const booksToSearch = [];
        if (primaryBook && world_names?.includes(primaryBook)) {
            booksToSearch.push(primaryBook);
        }
        extraBooks.forEach(book => {
            if (world_names?.includes(book) && !booksToSearch.includes(book)) {
                booksToSearch.push(book);
            }
        });
        
        if (!booksToSearch.length) {
            postToFrame({
                type: 'CHECK_STRANGER_WORLDBOOK_RESULT',
                requestId,
                found: false
            });
            return;
        }
        
        // 在所有世界书中搜索匹配的条目
        for (const bookName of booksToSearch) {
            const worldData = await loadWorldInfo(bookName);
            if (!worldData?.entries) continue;
            
            // 遍历所有条目，检查主要关键字是否包含陌路人名字
            for (const [uid, entry] of Object.entries(worldData.entries)) {
                const primaryKeys = Array.isArray(entry.key) ? entry.key : [];
                
                // 检查是否有任何主要关键字与陌路人名字匹配（不区分大小写）
                const matched = primaryKeys.some(key => {
                    const keyLower = (key || '').toLowerCase().trim();
                    const nameLower = (strangerName || '').toLowerCase().trim();
                    // 精确匹配或包含匹配
                    return keyLower === nameLower || keyLower.includes(nameLower) || nameLower.includes(keyLower);
                });
                
                if (matched) {
                    console.log('[Story Outline] Found matching worldbook entry:', {
                        bookName,
                        uid,
                        primaryKeys,
                        strangerName
                    });
                    
                    postToFrame({
                        type: 'CHECK_STRANGER_WORLDBOOK_RESULT',
                        requestId,
                        found: true,
                        worldbookUid: String(uid),
                        worldbook: bookName,
                        entryName: entry.comment || primaryKeys[0] || strangerName
                    });
                    return;
                }
            }
        }
        
        // 未找到匹配
        console.log('[Story Outline] No matching worldbook entry found for:', strangerName);
        postToFrame({
            type: 'CHECK_STRANGER_WORLDBOOK_RESULT',
            requestId,
            found: false
        });
        
    } catch (e) {
        console.error('[Story Outline] Check stranger worldbook error:', e);
        postToFrame({
            type: 'CHECK_STRANGER_WORLDBOOK_RESULT',
            requestId,
            found: false,
            error: e.message
        });
    }
}

/**
 * 处理生成 NPC 角色卡请求
 * 使用 4-role 结构生成完整 NPC 数据，并创建世界书条目
 */
async function handleGenerateNpc(data) {
    const { requestId, strangerName, strangerInfo } = data;
    console.log('[Story Outline] Generating NPC:', { strangerName, strangerInfo });
    
    try {
        const ctx = getContext();
        const character = ctx.characters?.[ctx.characterId];
        
        if (!character) {
            postToFrame({
                type: 'GENERATE_NPC_RESULT',
                requestId,
                error: '未找到当前角色卡'
            });
            return;
        }
        
        // 获取角色卡绑定的主世界书
        const primaryBook = character.data?.extensions?.world;
        if (!primaryBook || !world_names?.includes(primaryBook)) {
            postToFrame({
                type: 'GENERATE_NPC_RESULT',
                requestId,
                error: '角色卡未绑定世界书，请先绑定世界书'
            });
            return;
        }
        
        // 获取设置
        const commSettings = getCommSettings();
        const storyOutline = formatMapDataAsPrompt();
        const historyCount = commSettings.historyCount || 50;
        
        // 构建 4-role 消息
        const messages = buildNpcGenerationMessages({
            strangerName,
            strangerInfo: strangerInfo || '(无描述)',
            storyOutline,
            historyCount
        });
        
        console.log('[Story Outline] NPC generation messages:', messages);
        
        // 调用 LLM 生成
        let resultStr;
        let retryCount = 0;
        const maxRetries = 3;
        let npcData = null;
        
        while (retryCount < maxRetries) {
            try {
                resultStr = await callLLM(messages, true);  // useRaw = true
                console.log('[Story Outline] NPC generation result:', resultStr);
                
                // 尝试提取 JSON
                let jsonMatch = resultStr.match(/\{[\s\S]*"name"[\s\S]*\}/);
                if (jsonMatch) {
                    npcData = JSON.parse(jsonMatch[0]);
                    if (npcData.name && npcData.aliases) {
                        break;
                    }
                }
                
                // 直接解析
                try {
                    npcData = JSON.parse(resultStr);
                    if (npcData.name && npcData.aliases) {
                        break;
                    }
                } catch {}
                
                retryCount++;
                console.log(`[Story Outline] NPC JSON parse failed, retry ${retryCount}/${maxRetries}`);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) {
                retryCount++;
                console.error(`[Story Outline] NPC generation error, retry ${retryCount}/${maxRetries}:`, e);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        
        if (!npcData || !npcData.name) {
            postToFrame({
                type: 'GENERATE_NPC_RESULT',
                requestId,
                error: 'NPC 生成失败：无法解析 JSON 数据'
            });
            return;
        }
        
        // 加载世界书数据
        const worldData = await loadWorldInfo(primaryBook);
        if (!worldData) {
            postToFrame({
                type: 'GENERATE_NPC_RESULT',
                requestId,
                error: `无法加载世界书: ${primaryBook}`
            });
            return;
        }
        
        // 创建新条目
        const { createWorldInfoEntry } = await import("../../../../world-info.js");
        const newEntry = createWorldInfoEntry(primaryBook, worldData);
        
        if (!newEntry) {
            postToFrame({
                type: 'GENERATE_NPC_RESULT',
                requestId,
                error: '创建世界书条目失败'
            });
            return;
        }
        
        // 设置条目属性
        newEntry.key = npcData.aliases || [npcData.name];
        newEntry.comment = npcData.name;
        newEntry.content = formatNpcToWorldbookContent(npcData);
        newEntry.constant = false;
        newEntry.selective = true;
        newEntry.disable = false;
        // 应用 NPC 世界书条目位置设置
        newEntry.position = typeof commSettings.npcPosition === 'number' ? commSettings.npcPosition : 0;
        newEntry.order = typeof commSettings.npcOrder === 'number' ? commSettings.npcOrder : 100;
        
        // 保存世界书
        await saveWorldInfo(primaryBook, worldData, true);
        
        console.log('[Story Outline] NPC worldbook entry created:', {
            uid: newEntry.uid,
            name: npcData.name,
            aliases: npcData.aliases
        });
        
        // 返回结果
        postToFrame({
            type: 'GENERATE_NPC_RESULT',
            requestId,
            success: true,
            npcData,
            worldbookUid: String(newEntry.uid),
            worldbook: primaryBook
        });
        
    } catch (e) {
        console.error('[Story Outline] Generate NPC error:', e);
        postToFrame({
            type: 'GENERATE_NPC_RESULT',
            requestId,
            error: `生成失败: ${e.message}`
        });
    }
}

/**
 * 处理提取陌路人请求
 * 使用 4-role 结构从聊天历史中提取 NPC 列表
 */
async function handleExtractStrangers(data) {
    const { requestId, existingContacts, existingStrangers } = data;
    console.log('[Story Outline] Extracting strangers...', { 
        existingContacts: existingContacts?.length || 0, 
        existingStrangers: existingStrangers?.length || 0 
    });
    
    try {
        // 获取设置
        const commSettings = getCommSettings();
        const storyOutline = formatMapDataAsPrompt();
        const historyCount = commSettings.historyCount || 50;
        
        // 构建 4-role 消息
        const messages = buildExtractStrangersMessages({
            storyOutline,
            historyCount,
            existingContacts: existingContacts || [],
            existingStrangers: existingStrangers || []
        });
        
        console.log('[Story Outline] Extract strangers messages:', messages);
        
        // 调用 LLM 生成
        let resultStr;
        let retryCount = 0;
        const maxRetries = 3;
        let strangersData = null;
        
        while (retryCount < maxRetries) {
            try {
                resultStr = await callLLM(messages, true);  // useRaw = true
                console.log('[Story Outline] Extract strangers result:', resultStr);
                
                // 尝试提取 JSON 数组
                let jsonMatch = resultStr.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    strangersData = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(strangersData)) {
                        break;
                    }
                }
                
                // 直接解析
                try {
                    strangersData = JSON.parse(resultStr);
                    if (Array.isArray(strangersData)) {
                        break;
                    }
                } catch {}
                
                retryCount++;
                console.log(`[Story Outline] Strangers JSON parse failed, retry ${retryCount}/${maxRetries}`);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) {
                retryCount++;
                console.error(`[Story Outline] Extract strangers error, retry ${retryCount}/${maxRetries}:`, e);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        
        if (!Array.isArray(strangersData)) {
            postToFrame({
                type: 'EXTRACT_STRANGERS_RESULT',
                requestId,
                error: '提取失败：无法解析 JSON 数据'
            });
            return;
        }
        
        // 验证并清理数据，自动补充 avatar、color
        const validStrangers = strangersData.filter(s => s && s.name).map(s => ({
            name: s.name,
            avatar: s.name[0] || '?',
            color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
            location: s.location || '未知',
            info: s.info || ''
        }));
        
        console.log('[Story Outline] Extracted strangers:', validStrangers.length);
        
        // 返回结果
        postToFrame({
            type: 'EXTRACT_STRANGERS_RESULT',
            requestId,
            success: true,
            strangers: validStrangers
        });
        
    } catch (e) {
        console.error('[Story Outline] Extract strangers error:', e);
        postToFrame({
            type: 'EXTRACT_STRANGERS_RESULT',
            requestId,
            error: `提取失败: ${e.message}`
        });
    }
}

/**
 * 处理场景切换请求
 * 使用 4-role 结构计算偏差值、生成 side story 和局部地图
 */
async function handleSceneSwitch(data) {
    const { 
        requestId, 
        prevLocationName, 
        prevLocationInfo, 
        targetLocationName, 
        targetLocationType, 
        targetLocationInfo, 
        playerAction 
    } = data;
    
    console.log('[Story Outline] Scene switch...', { 
        from: prevLocationName, 
        to: targetLocationName, 
        type: targetLocationType 
    });
    
    try {
        const store = getOutlineStore();
        const commSettings = getCommSettings();
        const historyCount = commSettings.historyCount || 50;
        
        // 获取当前 stage 和 timeline
        const currentStage = store?.stage || 0;
        const timeline = store?.outlineData?.timeline;
        const currentTimeline = timeline?.find(t => t.stage === currentStage);
        
        // 格式化大纲信息
        const storyOutline = formatMapDataAsPrompt();
        
        // 构建 4-role 消息
        const messages = buildSceneSwitchMessages({
            prevLocationName: prevLocationName || '未知地点',
            prevLocationInfo: prevLocationInfo || '',
            targetLocationName: targetLocationName || '未知地点',
            targetLocationType: targetLocationType || 'sub',
            targetLocationInfo: targetLocationInfo || '',
            storyOutline,
            stage: currentStage,
            currentTimeline,
            historyCount,
            playerAction: playerAction || ''
        });
        
        console.log('[Story Outline] Scene switch messages:', messages);
        
        // 调用 LLM 生成
        let resultStr;
        let retryCount = 0;
        const maxRetries = 3;
        let sceneData = null;
        
        while (retryCount < maxRetries) {
            try {
                resultStr = await callLLM(messages, true);  // useRaw = true
                console.log('[Story Outline] Scene switch result:', resultStr);
                
                // 提取 JSON 对象
                let jsonMatch = resultStr.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    sceneData = JSON.parse(jsonMatch[0]);
                    if (sceneData.review && sceneData.scene_setup) {
                        break;
                    }
                }
                
                retryCount++;
                console.log(`[Story Outline] Scene JSON parse failed, retry ${retryCount}/${maxRetries}`);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) {
                retryCount++;
                console.error(`[Story Outline] Scene switch error, retry ${retryCount}/${maxRetries}:`, e);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        
        if (!sceneData || !sceneData.scene_setup) {
            postToFrame({
                type: 'SCENE_SWITCH_RESULT',
                requestId,
                error: '场景生成失败：无法解析 JSON 数据'
            });
            return;
        }
        
        // 更新 deviationScore
        const scoreDelta = sceneData.review?.deviation?.score_delta || 0;
        const oldScore = store?.deviationScore || 0;
        const newScore = Math.min(100, Math.max(0, oldScore + scoreDelta));
        
        if (store) {
            store.deviationScore = newScore;
            saveMetadataDebounced?.();
            console.log(`[Story Outline] Deviation score updated: ${oldScore} + ${scoreDelta} = ${newScore}`);
        }
        
        // 处理局部地图数据
        const localMap = sceneData.scene_setup?.local_map;
        const strangers = sceneData.scene_setup?.strangers || [];
        
        // 验证并清理陌路人数据
        const validStrangers = strangers.filter(s => s && s.name).map(s => ({
            name: s.name,
            avatar: s.name[0] || '?',
            color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
            location: s.location || targetLocationName,
            info: s.info || ''
        }));
        
        console.log('[Story Outline] Scene switch successful:', {
            scoreDelta,
            newScore,
            localMap: !!localMap,
            strangers: validStrangers.length
        });
        
        // 返回结果
        postToFrame({
            type: 'SCENE_SWITCH_RESULT',
            requestId,
            success: true,
            sceneData: {
                review: sceneData.review,
                sideStory: sceneData.scene_setup?.side_story,
                localMap,
                strangers: validStrangers,
                scoreDelta,
                newScore
            }
        });
        
    } catch (e) {
        console.error('[Story Outline] Scene switch error:', e);
        postToFrame({
            type: 'SCENE_SWITCH_RESULT',
            requestId,
            error: `场景切换失败: ${e.message}`
        });
    }
}

/**
 * 处理执行斜杠命令请求
 * 将场景切换的结果通过 /send 命令发送到主聊天
 */
async function handleExecuteSlashCommand(data) {
    const { command, sceneDescription } = data;
    console.log('[Story Outline] Executing slash command:', command);
    
    try {
        // 获取 SillyTavern 的 slash command 系统
        const { executeSlashCommands, executeSlashCommandsOnChatInput } = await import('../../../../slash-commands.js');
        
        if (executeSlashCommands) {
            // 使用 /send 命令发送消息
            await executeSlashCommands(command);
            console.log('[Story Outline] Slash command executed successfully');
            
            // 如果有场景描述，可以额外发送一条旁白
            if (sceneDescription) {
                // 使用 /narrator 或 /sys 发送场景描述
                await executeSlashCommands(`/narrator ${sceneDescription}`);
                console.log('[Story Outline] Scene description sent as narrator');
            }
        } else if (executeSlashCommandsOnChatInput) {
            // 备用方法：通过聊天输入框执行
            await executeSlashCommandsOnChatInput(command);
        } else {
            console.error('[Story Outline] Slash command system not available');
        }
    } catch (e) {
        console.error('[Story Outline] Execute slash command error:', e);
        
        // 备用方案：尝试直接操作输入框
        try {
            const chatInput = document.getElementById('send_textarea');
            if (chatInput) {
                // 提取 /send 后的内容
                const message = command.replace(/^\/send\s*/, '');
                chatInput.value = message;
                chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                console.log('[Story Outline] Fallback: Set chat input value');
            }
        } catch (fallbackError) {
            console.error('[Story Outline] Fallback also failed:', fallbackError);
        }
    }
}

/**
 * 处理发送邀请请求
 * 使用 4-role 结构判断角色是否接受邀请
 */
async function handleSendInvite(data) {
    const { requestId, contactName, contactUid, targetLocation, smsHistory, userLocation } = data;
    console.log('[Story Outline] Sending invite...', { contactName, targetLocation, userLocation });
    
    try {
        const commSettings = getCommSettings();
        const historyCount = commSettings.historyCount || 50;
        const storyOutline = formatMapDataAsPrompt();
        
        // 获取联络人的世界书条目内容
        let characterContent = '';
        if (contactUid) {
            const worldInfoData = world_info?.entries || world_info || {};
            const entries = Object.values(worldInfoData);
            const entry = entries.find(e => e.uid?.toString() === contactUid.toString());
            if (entry?.content) {
                characterContent = entry.content;
            }
        }
        
        // 构建短信历史
        const smsHistoryContent = buildSmsHistoryContent(smsHistory || '');
        
        // 构建 4-role 消息
        const messages = buildInviteMessages({
            contactName,
            userName: name1 || '{{user}}',
            targetLocation,
            storyOutline,
            historyCount,
            smsHistoryContent,
            characterContent
        });
        
        console.log('[Story Outline] Invite messages:', messages);
        
        // 调用 LLM 生成
        let resultStr;
        let retryCount = 0;
        const maxRetries = 3;
        let inviteData = null;
        
        while (retryCount < maxRetries) {
            try {
                resultStr = await callLLM(messages, true);
                console.log('[Story Outline] Invite result:', resultStr);
                
                // 提取 JSON 对象
                let jsonMatch = resultStr.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    inviteData = JSON.parse(jsonMatch[0]);
                    if (typeof inviteData.invite === 'boolean' && inviteData.reply) {
                        break;
                    }
                }
                
                retryCount++;
                console.log(`[Story Outline] Invite JSON parse failed, retry ${retryCount}/${maxRetries}`);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) {
                retryCount++;
                console.error(`[Story Outline] Invite error, retry ${retryCount}/${maxRetries}:`, e);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        
        if (!inviteData || typeof inviteData.invite !== 'boolean') {
            postToFrame({
                type: 'SEND_INVITE_RESULT',
                requestId,
                error: '邀请处理失败：无法解析 JSON 数据'
            });
            return;
        }
        
        console.log('[Story Outline] Invite decision:', {
            accepted: inviteData.invite,
            reply: inviteData.reply
        });
        
        // 如果接受邀请且用户当前位置就是邀请地点，发送 /send 命令
        let sendNow = false;
        if (inviteData.invite && userLocation === targetLocation) {
            sendNow = true;
            try {
                const { executeSlashCommands } = await import('../../../../slash-commands.js');
                if (executeSlashCommands) {
                    await executeSlashCommands(`/send ${name1 || '{{user}}'}邀请了${contactName}过来，${contactName}已经到达。`);
                    console.log('[Story Outline] Invite /send executed');
                }
            } catch (e) {
                console.error('[Story Outline] Failed to send invite notification:', e);
            }
        }
        
        // 返回结果
        postToFrame({
            type: 'SEND_INVITE_RESULT',
            requestId,
            success: true,
            inviteData: {
                accepted: inviteData.invite,
                reply: inviteData.reply,
                targetLocation,
                sendNow
            }
        });
        
    } catch (e) {
        console.error('[Story Outline] Send invite error:', e);
        postToFrame({
            type: 'SEND_INVITE_RESULT',
            requestId,
            error: `邀请处理失败: ${e.message}`
        });
    }
}

/**
 * 处理世界生成请求
 * 使用 4-role 结构生成完整的世界数据
 */
async function handleGenerateWorld(data) {
    const { requestId, playerRequests } = data;
    console.log('[Story Outline] Generating world...', { playerRequests });
    
    try {
        const commSettings = getCommSettings();
        const historyCount = commSettings.historyCount || 50;
        
        // 构建 4-role 消息，worldInfo 占位符在函数内部已定义
        const messages = buildWorldGenMessages({
            playerRequests: playerRequests || '',
            historyCount
        });
        
        console.log('[Story Outline] World generation messages:', messages);
        
        // 调用 LLM 生成
        let resultStr;
        let retryCount = 0;
        const maxRetries = 3;
        let worldData = null;
        
        while (retryCount < maxRetries) {
            try {
                resultStr = await callLLM(messages, true);  // useRaw = true
                console.log('[Story Outline] World generation result:', resultStr);
                
                // 直接提取 JSON 对象，忽略任何前缀文字（如 ```json、"好的"等）
                let jsonMatch = resultStr.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    worldData = JSON.parse(jsonMatch[0]);
                    if (worldData.meta && worldData.timeline) {
                        break;
                    }
                }
                
                retryCount++;
                console.log(`[Story Outline] World JSON parse failed, retry ${retryCount}/${maxRetries}`);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) {
                retryCount++;
                console.error(`[Story Outline] World generation error, retry ${retryCount}/${maxRetries}:`, e);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        
        if (!worldData || !worldData.meta) {
            postToFrame({
                type: 'GENERATE_WORLD_RESULT',
                requestId,
                error: '世界生成失败：无法解析 JSON 数据'
            });
            return;
        }
        
        console.log('[Story Outline] World generated successfully');
        
        // 世界生成成功后重置 stage 和 deviationScore
        const store = getOutlineStore();
        if (store) {
            store.stage = 0;
            store.deviationScore = 0;
            saveMetadataDebounced?.();
            console.log('[Story Outline] Reset stage and deviationScore to 0');
        }
        
        // 返回结果
        postToFrame({
            type: 'GENERATE_WORLD_RESULT',
            requestId,
            success: true,
            worldData
        });
        
    } catch (e) {
        console.error('[Story Outline] Generate world error:', e);
        postToFrame({
            type: 'GENERATE_WORLD_RESULT',
            requestId,
            error: `生成失败: ${e.message}`
        });
    }
}

/**
 * 处理世界推演请求
 * 使用 4-role 结构推演世界状态变化（演化而非重置）
 */
async function handleSimulateWorld(data) {
    const { requestId, currentData } = data;
    console.log('[Story Outline] Simulating world evolution...');
    
    try {
        const commSettings = getCommSettings();
        const historyCount = commSettings.historyCount || 50;
        
        // 构建 4-role 消息
        const messages = buildWorldSimMessages({
            currentWorldData: currentData || '{}',
            historyCount
        });
        
        console.log('[Story Outline] World simulation messages:', messages);
        
        // 调用 LLM 生成
        let resultStr;
        let retryCount = 0;
        const maxRetries = 3;
        let simData = null;
        
        while (retryCount < maxRetries) {
            try {
                resultStr = await callLLM(messages, true);  // useRaw = true
                console.log('[Story Outline] World simulation result:', resultStr);
                
                // 直接提取 JSON 对象
                let jsonMatch = resultStr.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    simData = JSON.parse(jsonMatch[0]);
                    if (simData.meta && simData.timeline) {
                        break;
                    }
                }
                
                retryCount++;
                console.log(`[Story Outline] Sim JSON parse failed, retry ${retryCount}/${maxRetries}`);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) {
                retryCount++;
                console.error(`[Story Outline] World simulation error, retry ${retryCount}/${maxRetries}:`, e);
                if (retryCount < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        
        if (!simData || !simData.meta) {
            postToFrame({
                type: 'SIMULATE_WORLD_RESULT',
                requestId,
                error: '世界推演失败：无法解析 JSON 数据'
            });
            return;
        }
        
        console.log('[Story Outline] World simulation successful');
        
        // 推演成功后增加 stage
        const store = getOutlineStore();
        if (store) {
            // 从推演结果中获取新的 stage，或自增 1
            const newTimeline = simData.timeline?.[0];
            if (newTimeline && typeof newTimeline.stage === 'number') {
                store.stage = newTimeline.stage;
            } else {
                store.stage = (store.stage || 0) + 1;
            }
            saveMetadataDebounced?.();
            console.log('[Story Outline] Stage advanced to:', store.stage);
        }
        
        // 返回结果
        postToFrame({
            type: 'SIMULATE_WORLD_RESULT',
            requestId,
            success: true,
            simData
        });
        
    } catch (e) {
        console.error('[Story Outline] Simulate world error:', e);
        postToFrame({
            type: 'SIMULATE_WORLD_RESULT',
            requestId,
            error: `推演失败: ${e.message}`
        });
    }
}

function loadAndSendMapData() {
    const store = getOutlineStore();
    if (store?.mapData) {
        postToFrame({ type: "LOAD_MAP_DATA", mapData: store.mapData });
    }
    // 同时发送设置
    sendSettingsToFrame();
}

// ================== 通用指针交互 ==================
function setupPointerDrag(el, { onStart, onMove, onEnd, shouldHandle }) {
    if (!el) return;
    let state = null;
    
    el.addEventListener('pointerdown', e => {
        if (shouldHandle && !shouldHandle()) return;
        e.preventDefault();
        e.stopPropagation();
        state = onStart(e);
        state.pointerId = e.pointerId;
        el.setPointerCapture(e.pointerId);
    });
    
    el.addEventListener('pointermove', e => state && onMove(e, state));
    
    const endHandler = () => {
        if (!state) return;
        onEnd?.(state);
        try { el.releasePointerCapture(state.pointerId); } catch {}
        state = null;
    };
    
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(evt => 
        el.addEventListener(evt, endHandler)
    );
}

// ================== Overlay ==================
function createOverlay() {
    if (overlayCreated) return;
    overlayCreated = true;

    const $overlay = $(buildOverlayHtml(iframePath));

    document.body.appendChild($overlay[0]);

    const overlay = document.getElementById("xiaobaix-story-outline-overlay");
    const wrap = overlay.querySelector(".xb-so-frame-wrap");
    const iframe = overlay.querySelector("iframe");
    const setIframePointer = v => iframe && (iframe.style.pointerEvents = v);

    // 拖拽
    setupPointerDrag(overlay.querySelector(".xb-so-drag-handle"), {
        shouldHandle: () => !isMobile(),
        onStart(e) {
            const r = wrap.getBoundingClientRect(), ro = overlay.getBoundingClientRect();
            wrap.style.left = (r.left - ro.left) + 'px';
            wrap.style.top = (r.top - ro.top) + 'px';
            wrap.style.transform = '';
            setIframePointer('none');
            return { sx: e.clientX, sy: e.clientY, sl: parseFloat(wrap.style.left), st: parseFloat(wrap.style.top) };
        },
        onMove(e, s) {
            const maxL = overlay.clientWidth - wrap.offsetWidth;
            const maxT = overlay.clientHeight - wrap.offsetHeight;
            wrap.style.left = Math.max(0, Math.min(maxL, s.sl + e.clientX - s.sx)) + 'px';
            wrap.style.top = Math.max(0, Math.min(maxT, s.st + e.clientY - s.sy)) + 'px';
        },
        onEnd: () => setIframePointer('')
    });

    // PC缩放
    setupPointerDrag(overlay.querySelector(".xb-so-resize-handle"), {
        shouldHandle: () => !isMobile(),
        onStart(e) {
            const r = wrap.getBoundingClientRect(), ro = overlay.getBoundingClientRect();
            wrap.style.left = (r.left - ro.left) + 'px';
            wrap.style.top = (r.top - ro.top) + 'px';
            wrap.style.transform = '';
            setIframePointer('none');
            return { sx: e.clientX, sy: e.clientY, sw: wrap.offsetWidth, sh: wrap.offsetHeight, ratio: wrap.offsetWidth / wrap.offsetHeight };
        },
        onMove(e, s) {
            const dx = e.clientX - s.sx, dy = e.clientY - s.sy;
            const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy * s.ratio;
            let w = Math.max(400, Math.min(window.innerWidth * 0.95, s.sw + delta));
            let h = w / s.ratio;
            if (h > window.innerHeight * 0.9) { h = window.innerHeight * 0.9; w = h * s.ratio; }
            if (h < 300) { h = 300; w = h * s.ratio; }
            wrap.style.width = w + 'px';
            wrap.style.height = h + 'px';
        },
        onEnd: () => setIframePointer('')
    });

    // 移动端缩放
    setupPointerDrag(overlay.querySelector(".xb-so-resize-mobile"), {
        shouldHandle: () => isMobile(),
        onStart(e) {
            setIframePointer('none');
            return { sy: e.clientY, sh: wrap.offsetHeight };
        },
        onMove(e, s) {
            wrap.style.height = Math.max(200, Math.min(window.innerHeight * 0.9, s.sh + e.clientY - s.sy)) + 'px';
        },
        onEnd: () => setIframePointer('')
    });

    window.addEventListener("message", handleFrameMessage);
}

function updateLayout() {
    const wrap = document.querySelector(".xb-so-frame-wrap");
    const dragHandle = document.querySelector(".xb-so-drag-handle");
    const resizeHandle = document.querySelector(".xb-so-resize-handle");
    const resizeMobile = document.querySelector(".xb-so-resize-mobile");
    if (!wrap) return;

    if (isMobile()) {
        if (dragHandle) dragHandle.style.display = 'none';
        if (resizeHandle) resizeHandle.style.display = 'none';
        if (resizeMobile) resizeMobile.style.display = 'flex';
        wrap.style.cssText = MOBILE_LAYOUT_STYLE;
    } else {
        if (dragHandle) dragHandle.style.display = 'block';
        if (resizeHandle) resizeHandle.style.display = 'block';
        if (resizeMobile) resizeMobile.style.display = 'none';
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

function hideOverlay() {
    $("#xiaobaix-story-outline-overlay").hide();
}

$(window).on('resize', () => {
    if ($("#xiaobaix-story-outline-overlay").is(':visible')) updateLayout();
});

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
        e.preventDefault();
        e.stopPropagation();
        if (!getSettings().storyOutline?.enabled) return;
        currentMesId = Number(mesId);
        showOverlay();
        loadAndSendMapData();
    });

    // 联动 button-collapse.js
    if (window.registerButtonToSubContainer?.(mesId, btn)) return;
    msg.querySelector('.flex-container.flex1.alignitemscenter')?.appendChild(btn);
}

function initButtons() {
    if (!getSettings().storyOutline?.enabled) return;
    $("#chat .mes").each((_, el) => {
        const mesId = el.getAttribute("mesid");
        if (mesId != null) addOutlineBtnToMessage(mesId);
    });
}

// ================== 事件 ==================
function registerEvents() {
    initButtons();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            initButtons();
            updateOutlinePromptContent();  // 切换聊天时更新内容
        }, 80);
    });

    const buttonHandler = data => {
        setTimeout(() => {
            const mesId = data?.element ? $(data.element).attr("mesid") : data?.messageId;
            mesId == null ? initButtons() : addOutlineBtnToMessage(mesId);
        }, 50);
    };

    [
        event_types.USER_MESSAGE_RENDERED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_EDITED,
    ].forEach(t => eventSource.on(t, buttonHandler));

    // 剧情地图子开关
    $(document).on("xiaobaix:storyOutline:toggle", (_e, enabled) => {
        if (enabled) {
            initButtons();
            injectOutlinePrompt();
        } else {
            $(".xiaobaix-story-outline-btn").remove();
            hideOverlay();
            removeOutlinePrompt();
        }
    });
    
    // 总开关切换（原生事件，与其他组件统一）
    document.addEventListener('xiaobaixEnabledChanged', (e) => {
        const enabled = e?.detail?.enabled;
        if (enabled) {
            // 总开关开启，检查剧情地图是否启用
            if (getSettings().storyOutline?.enabled) {
                initButtons();
                outlinePromptInjected = false;
                injectOutlinePrompt();
            }
        } else {
            // 总开关关闭，直接清理
            $(".xiaobaix-story-outline-btn").remove();
            hideOverlay();
            removeOutlinePrompt();
        }
    });
    
    // 切换预设后重新注入（仅在功能启用时）
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        if (!getSettings().storyOutline?.enabled) return;
        outlinePromptInjected = false;
        setTimeout(injectOutlinePrompt, 100);
    });
    
    // Chat Completion 设置加载后注入
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, () => {
        if (!getSettings().storyOutline?.enabled) return;
        setTimeout(injectOutlinePrompt, 100);
    });
    
    // 在生成开始前更新 prompt 内容
    eventSource.on(event_types.GENERATION_STARTED, () => {
        updateOutlinePromptContent();
    });
    
    // 首次加载时也尝试注入
    setTimeout(injectOutlinePrompt, 500);
}

// ================== 清理/初始化 ==================
function cleanup() {
    $(".xiaobaix-story-outline-btn").remove();
    hideOverlay();
    overlayCreated = false;
    frameReady = false;
    pendingFrameMessages = [];
    removeOutlinePrompt();  // 清理时也移除 prompt 条目
    window.removeEventListener("message", handleFrameMessage);
    document.getElementById("xiaobaix-story-outline-overlay")?.remove();
}

jQuery(() => {
    if (!getSettings().storyOutline?.enabled) return;
    registerEvents();
    window.registerModuleCleanup?.('storyOutline', cleanup);
});

export { cleanup };