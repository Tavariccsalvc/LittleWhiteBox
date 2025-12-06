// Story Outline 提示词模板配置
// 统一的 4-role 消息构建系统

// ================================================================================
// 统一变量管理
// ================================================================================

/**
 * 【通用变量】- 所有/多数函数共用
 * ┌─────────────────┬────────────────────────────────────────────────────┐
 * │ 变量名           │ 说明                                               │
 * ├─────────────────┼────────────────────────────────────────────────────┤
 * │ worldInfo       │ 世界书占位符 {$worldInfo}，ST替换为完整世界书       │
 * │ history         │ 历史占位符 {$historyN}，ST替换为最近N楼聊天记录     │
 * │ outline         │ 剧情大纲（L1-L7洋葱层、timeline、outcomes的JSON）  │
 * └─────────────────┴────────────────────────────────────────────────────┘
 * 
 * 【专用变量】- 各函数特有
 * ┌─────────────────┬────────────────────────────────────────────────────┐
 * │ 函数             │ 专用变量                                          │
 * ├─────────────────┼────────────────────────────────────────────────────┤
 * │ 1.短信回复       │ contactName, userName, smsHistory, userMessage,   │
 * │                  │ characterContent(角色世界书条目)                   │
 * ├─────────────────┼────────────────────────────────────────────────────┤
 * │ 2.总结压缩       │ existingSummary, conversationText                 │
 * ├─────────────────┼────────────────────────────────────────────────────┤
 * │ 3.邀请回复       │ contactName, userName, targetLocation,            │
 * │                  │ smsHistory, characterContent                      │
 * ├─────────────────┼────────────────────────────────────────────────────┤
 * │ 4.NPC生成        │ strangerName, strangerInfo                        │
 * ├─────────────────┼────────────────────────────────────────────────────┤
 * │ 5.提取陌路人     │ existingContacts[], existingStrangers[]           │
 * ├─────────────────┼────────────────────────────────────────────────────┤
 * │ 6.世界生成       │ playerRequests                                    │
 * ├─────────────────┼────────────────────────────────────────────────────┤
 * │ 7.世界推演       │ currentWorldData(当前世界状态JSON)                │
 * ├─────────────────┼────────────────────────────────────────────────────┤
 * │ 8.场景切换       │ prevLocation, targetLocation, stage,              │
 * │                  │ currentTimeline, playerAction                     │
 * └─────────────────┴────────────────────────────────────────────────────┘
 */

// ================================================================================
// 通用变量构建器
// ================================================================================

/** 世界书 + 角色描述 - ST占位符 */
const worldInfo = `<world_info>\n{{description}}{$worldInfo}\n</world_info>`;

/** 历史记录 - ST占位符（需要传入楼层数） */
const history = (count) => `<chat_history>\n{$history${count}}\n</chat_history>`;

/** 剧情大纲 - 直接内容 */
const outline = (content) => content ? `<story_outline>\n${content}\n</story_outline>` : '';

/** 角色人设 - 直接内容 */
const character = (name, content) => content ? `<${name}的人物设定>\n${content}\n</${name}的人物设定>` : '';

/** 短信历史 */
const smsHistory = (text) => text 
    ? `<已有短信>\n${text}\n</已有短信>` 
    : '<已有短信>\n（空白，首次对话）\n</已有短信>';

/** 已有总结 */
const existingSummary = (text) => text 
    ? `<已有总结>\n${text}\n</已有总结>` 
    : '<已有总结>\n（空白，首次总结）\n</已有总结>';

/** 已存在角色名单 */
const existingNames = (contacts, strangers) => {
    const names = [...(contacts || []).map(c => c.name), ...(strangers || []).map(s => s.name)];
    return names.length ? `\n\n**已存在角色（不要重复）：** ${names.join('、')}` : '';
};

/** 时间线信息 */
const timeline = (obj) => obj ? `Stage ${obj.stage}: ${obj.state} - ${obj.event}` : '';

/** 地点信息 */
const location = (name, info) => `${name}: ${info || '无详细信息'}`;

// 导出辅助函数（兼容旧代码）
export const buildSmsHistoryContent = smsHistory;
export const buildExistingSummaryContent = existingSummary;

/** 构建标准 4-role 消息数组 */
const build4RoleArray = (userTask, assistantAck, userInput, assistantStart) => [
    { role: 'user', content: userTask },
    { role: 'assistant', content: assistantAck },
    { role: 'user', content: userInput },
    { role: 'assistant', content: assistantStart }
];

// ================================================================================
// 4-Role 消息构建函数
// ================================================================================

/** 1. 短信回复 */
export function buildSmsMessages({ contactName, userName, storyOutline, historyCount, smsHistoryContent, userMessage, characterContent }) {
    const _outline = outline(storyOutline);
    const _character = character(contactName, characterContent);
    
    return build4RoleArray(
        `现在是短信模拟场景。\n\n${_outline}${_outline ? '\n\n' : ''}${worldInfo}\n\n${history(historyCount)}\n\n以上是设定和聊天历史，遵守人设，忽略规则类信息和非${contactName}经历的内容。以${contactName}身份回复${userName}的短信（仅输出回复内容）。字数精简，10～30字左右。${_character ? `\n\n${_character}` : ''}`,
        `明白，我只输出${contactName}的回复短信，请提供已有短信历史。`,
        `${smsHistoryContent}\n\n<${userName}发来的新短信>\n${userMessage}`,
        `了解，开始以${contactName}进行回复:`
    );
}

/** 2. 总结压缩 */
export function buildSummaryMessages({ existingSummaryContent, conversationText }) {
    return build4RoleArray(
        `你是剧情记录员。根据新短信聊天内容提取新增剧情要素。\n\n任务：只根据新对话输出增量内容，不重复已有总结。\n事件筛选：只记录有信息量的完整事件。`,
        `明白，我只输出新增内容，请提供已有总结和新对话内容。`,
        `${existingSummaryContent}\n\n<新对话内容>\n${conversationText}\n</新对话内容>\n\n输出要求：\n- 只输出一个合法JSON对象\n- 内部文本使用中文单引号\n\n格式：{"summary": "角色A向角色B打招呼，并表示会守护在旁边"}`,
        `了解，开始生成JSON:`
    );
}

// ================== JSON 模板常量 ==================

export const INVITE_JSON_TEMPLATE = `{ "cot": "思维链分析...", "invite": true, "reply": "回复短信内容" }`;

export const NPC_JSON_TEMPLATE = `{
  "name": "角色全名", "aliases": ["别名1", "别名2"],
  "intro": "一句话外貌与职业", "background": "角色生平",
  "persona": { "keywords": ["性格1","性格2"], "speaking_style": "说话风格、口癖", "motivation": "核心驱动力" },
  "game_data": { "stance": "阵营态度", "secret": "掌握的秘密" }
}`;

export const STRANGER_JSON_TEMPLATE = `[{ "name": "角色名", "location": "当前地点", "info": "一句话简介" }]`;

export const WORLD_GEN_JSON_TEMPLATE = `{
  "meta": {
    "truth": { "overview": "一句话核心真相",
      "onion_layers": {
        "L1_Surface": [{ "desc": "表象", "logic": "实际情况" }],
        "L2_Traces": [{ "desc": "物证", "logic": "揭示信息" }],
        "L3_Mechanism": [{ "desc": "机制", "logic": "指向核心" }],
        "L4_Nodes": [{ "desc": "节点", "logic": "作用" }],
        "L5_Core": { "desc": "核心源头", "logic": "能力" },
        "L6_Drive": { "desc": "驱动力", "logic": "为何产生" },
        "L7_Consequence": { "desc": "无人干涉结局", "logic": "后果" }
      }
    },
    "outcomes": { "default_end": "顺其自然", "intervention_end": "部分介入", "resolution_end": "完美解决" }
  },
  "timeline": [{ "stage": 0, "state": "状态", "event": "事件" }],
  "world": { "news": [{ "title": "标题", "time": "时间", "content": "内容" }] },
  "maps": { "outdoor": { "description": "全景描写含[[节点名]]", "nodes": [{ "name": "地点", "position": "方位", "distant": 1, "type": "main/sub/home", "info": "特征" }] } }
}`;

export const WORLD_SIM_JSON_TEMPLATE = `{
  "meta": { "truth": { "overview": "保持或微调",
    "onion_layers": {
      "L1_Surface": [{ "desc": "更新流言", "logic": "..." }], "L2_Traces": [{ "desc": "新线索", "logic": "..." }],
      "L3_Mechanism": [{ "desc": "机制变化", "logic": "..." }], "L4_Nodes": [{ "desc": "新动向", "logic": "..." }],
      "L5_Core": { "desc": "保持", "logic": "保持" }, "L6_Drive": { "desc": "保持", "logic": "保持" }, "L7_Consequence": { "desc": "保持", "logic": "保持" }
    } },
    "outcomes": { "default_end": "保持", "intervention_end": "微调", "resolution_end": "保持" }
  },
  "timeline": [{ "stage": "N+1", "state": "新状态", "event": "新事件" }],
  "world": { "news": [{ "title": "新标题", "time": "...", "content": "..." }] },
  "maps": { "outdoor": { "description": "更新描写", "nodes": [] } }
}`;

export const SCENE_SWITCH_JSON_TEMPLATE = `{
  "review": { "deviation": { "cot_analysis": "分析玩家行为影响", "score_delta": 0, "prev_loc_update": "地点变化描写" } },
  "scene_setup": {
    "side_story": { "story": "本场景剧情", "surface": "表层钩子", "inner": "里层真相" },
    "local_map": { "name": "地点名", "description": "全景描写含[[节点]]", "nodes": [{ "name": "节点", "position": "方位", "distant": 1, "type": "main/sub/interact", "info": "描写" }] },
    "strangers": [{ "name": "NPC名", "location": "节点", "info": "外貌行为" }]
  }
}`;

// ================== 更多 4-Role 构建函数 ==================

/** 3. 邀请回复 */
export function buildInviteMessages({ contactName, userName, targetLocation, storyOutline, historyCount, smsHistoryContent, characterContent }) {
    const _outline = outline(storyOutline);
    const _character = character(contactName, characterContent);
    
    return build4RoleArray(
        `你是短信模拟器。${userName}正在邀请${contactName}前往「${targetLocation}」。\n\n${_outline}${_outline ? '\n\n' : ''}${worldInfo}\n\n${history(historyCount)}${_character ? `\n\n${_character}` : ''}\n\n根据${contactName}的人设、处境、与${userName}的关系，判断是否答应。\n\n**判断参考**：亲密度、当前事务、地点危险性、角色性格\n\n输出JSON："cot"(思维链)、"invite"(true/false)、"reply"(10-50字回复)\n\n模板：${INVITE_JSON_TEMPLATE}`,
        `明白，我将分析${contactName}是否答应并以角色语气回复。请提供短信历史。`,
        `${smsHistoryContent}\n\n<${userName}发来的新短信>\n我邀请你前往「${targetLocation}」，你能来吗？`,
        `了解，开始生成JSON:`
    );
}

/** 4. NPC 生成 */
export function buildNpcGenerationMessages({ strangerName, strangerInfo, storyOutline, historyCount }) {
    const _outline = outline(storyOutline) || '<story_outline>\n(无)\n</story_outline>';
    
    return build4RoleArray(
        `你是TRPG角色生成器。将陌生人【${strangerName} - ${strangerInfo}】扩充为完整NPC。基于世界观和剧情大纲，输出严格JSON。`,
        `明白。请提供上下文，我将严格按JSON输出，不含多余文本。`,
        `${worldInfo}\n\n${history(historyCount)}\n\n剧情秘密大纲（*从这里提取线索赋予角色秘密*）：\n${_outline}\n\n需要生成：【${strangerName} - ${strangerInfo}】\n\n输出要求：\n1. 合法JSON\n2. 内部用单引号，禁用双引号\n3. aliases须含简称或绰号\n\n模板：${NPC_JSON_TEMPLATE}`,
        `了解，开始生成JSON:`
    );
}

/** 将 NPC JSON 转换为世界书条目内容 */
export function formatNpcToWorldbookContent(npcData) {
    const lines = [`【${npcData.name}】`];
    if (npcData.aliases?.length) lines.push(`别名：${npcData.aliases.join('、')}`);
    lines.push('');
    if (npcData.intro) lines.push(`外貌/职业：${npcData.intro}`, '');
    if (npcData.background) lines.push(`背景：${npcData.background}`, '');
    if (npcData.persona) {
        lines.push('性格特征：');
        if (npcData.persona.keywords?.length) lines.push(`- 关键词：${npcData.persona.keywords.join('、')}`);
        if (npcData.persona.speaking_style) lines.push(`- 说话风格：${npcData.persona.speaking_style}`);
        if (npcData.persona.motivation) lines.push(`- 行动动机：${npcData.persona.motivation}`);
        lines.push('');
    }
    if (npcData.game_data) {
        lines.push('游戏相关：');
        if (npcData.game_data.stance) lines.push(`- 阵营态度：${npcData.game_data.stance}`);
        if (npcData.game_data.secret) lines.push(`- 隐藏秘密：${npcData.game_data.secret}`);
    }
    return lines.join('\n').trim();
}

/** 5. 提取陌路人 */
export function buildExtractStrangersMessages({ storyOutline, historyCount, existingContacts, existingStrangers }) {
    const _outline = outline(storyOutline);
    const _existingNames = existingNames(existingContacts, existingStrangers);
    
    return [
        { role: 'system', content: `你是TRPG数据整理助手。从剧情文本中提取玩家遇到的陌生人/NPC，整理为JSON数组。` },
        { role: 'user', content: `请准备提取NPC列表。我将提供世界观和玩家经历。` },
        { role: 'assistant', content: `明白。请提供【世界观】和【剧情经历】，我将提取角色并以JSON数组输出。` },
        { role: 'user', content: `### 上下文\n\n**1. 世界观：**\n${worldInfo}\n\n**2. 玩家经历：**\n${history(historyCount)}${_outline ? `\n\n**剧情大纲：**\n${_outline}` : ''}${_existingNames}\n\n### 输出要求\n\n1. JSON数组\n2. 只提取有具体称呼的角色\n3. 每个角色只需name/location/info\n4. 无新角色返回 []\n\n模板：${STRANGER_JSON_TEMPLATE}` }
    ];
}

/** 6. 世界生成 */
export function buildWorldGenMessages({ playerRequests, historyCount }) {
    return build4RoleArray(
        `你是TRPG动态叙事引擎。根据【题材风格】构建逻辑自洽、曲折吸引人的初始剧情状态。

核心原则：
1. **自适应基调**：分析题材风格(恐怖→不可知,日常→羁绊,脑洞→反直觉)。严禁轻松题材强制引入灾难。
2. **真相结构**（L1-L7）：表象→痕迹→机制→节点→核心→驱动→后果
3. **时间轴**：4-7阶段，演变符合题材
4. **结局**：Default/Intervention/Resolution
5. **世界**：News至少3条，Maps至少7个地点
6. **历史参考**：参考玩家经历构建世界

输出：仅纯净合法JSON，禁止解释文字或Markdown。`,
        `明白。我将分析题材风格，遵循L1→L7模型构建JSON。请提供设定。`,
        `【世界观与要求】：\n${worldInfo}\n\n【玩家经历参考】：\n${history(historyCount)}\n\n【玩家要求】：\n${playerRequests || '无特殊要求'}\n\n【JSON模板】：\n${WORLD_GEN_JSON_TEMPLATE}`,
        `严格生成JSON，不擅自修改。JSON生成开始:`
    );
}

/** 7. 世界推演 */
export function buildWorldSimMessages({ currentWorldData, historyCount }) {
    return build4RoleArray(
        `你是世界演化引擎。推动时间流逝，根据【玩家历史行为】和【既定命运】计算世界下一状态。

演化逻辑：
1. **历史回顾**：分析玩家行为影响（摧毁据点→变废墟，忽略威胁→恶化）
2. **真相迭代**：L5-L7保持不变；L1-L2大幅更新；L3-L4适度更新
3. **地图重构**：Main保留原名更新info；约30%的Sub结构性变化
4. **时间推进**：Stage推进，生成全新News

输出：完整JSON，结构与模板一致，禁止解释文字。`,
        `明白。我将读取当前状态和玩家历史，推演变化。保留核心，更新30%次级节点，刷新新闻和浅层线索。请提供数据。`,
        `【世界观设定】：\n${worldInfo}\n\n【玩家历史】：\n${history(historyCount)}\n\n【当前世界状态】：\n${currentWorldData || '{}'}\n\n【JSON模板】：\n${WORLD_SIM_JSON_TEMPLATE}`,
        `演化计算完成。JSON output start:`
    );
}

/** 8. 场景切换 */
export function buildSceneSwitchMessages({ prevLocationName, prevLocationInfo, targetLocationName, targetLocationType, targetLocationInfo, storyOutline, stage, currentTimeline, historyCount, playerAction }) {
    const _outline = outline(storyOutline);
    const _prevLocation = location(prevLocationName, prevLocationInfo);
    const _targetLocation = `名称: ${targetLocationName}\n类型: ${targetLocationType}\n描述: ${targetLocationInfo || '无详细信息'}`;
    const _timeline = currentTimeline ? timeline(currentTimeline) : `Stage ${stage}`;
    
    const typeBonus = targetLocationType === 'main' ? 3 : (targetLocationType === 'sub' ? 2 : 1);
    const lLevel = Math.min(7, stage + typeBonus);
    
    return build4RoleArray(
        `你是TRPG场景管理器。处理玩家移动请求，结算上一地点后果，构建新地点场景。

处理逻辑：
1. **历史结算**：分析玩家最后行为，计算偏差值(0-4无关/5-10干扰/11-20转折)，描述离开后地点变化
2. **故事生成**：用L${lLevel}级元素生成Side Story（表层钩子+里层真相）
3. **局部地图**：Description全景式描写，节点用[[名]]包裹；生成3-6个节点和0-3个NPC

输出：仅符合模板的JSON，禁止解释文字。`,
        `明白。我将结算偏差值，基于L${lLevel}深度生成Side Story和局部地图JSON。请发送上下文。`,
        `【上一地点】：\n${_prevLocation}\n\n【世界设定】：\n${worldInfo}\n\n【剧情大纲】：\n${_outline || '无大纲'}\n\n【当前时间段】：\n${_timeline}\n\n【历史记录】：\n${history(historyCount)}\n\n【玩家行动意图】：\n${playerAction || '无特定意图'}\n\n【目标地点】：\n${_targetLocation}\n\n【JSON模板】：\n${SCENE_SWITCH_JSON_TEMPLATE}`,
        `OK, JSON generate start:`
    );
}

// ================== Overlay HTML 模板 ==================

const FRAME_BASE = 'position:absolute!important;z-index:1!important;pointer-events:auto!important;border-radius:12px!important;box-shadow:0 8px 32px rgba(0,0,0,.4)!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;background:#f4f4f4!important;';

export function buildOverlayHtml(iframeSrc) {
    return `<div id="xiaobaix-story-outline-overlay" style="position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:99999!important;display:none;overflow:hidden!important;pointer-events:none!important;">
    <div class="xb-so-frame-wrap" style="${FRAME_BASE}">
        <div class="xb-so-drag-handle" style="position:absolute!important;top:0!important;left:0!important;width:200px!important;height:48px!important;z-index:10!important;cursor:move!important;background:transparent!important;touch-action:none!important;"></div>
        <iframe id="xiaobaix-story-outline-iframe" class="xiaobaix-iframe" src="${iframeSrc}" style="width:100%!important;height:100%!important;border:none!important;background:#f4f4f4!important;"></iframe>
        <div class="xb-so-resize-handle" style="position:absolute!important;right:0!important;bottom:0!important;width:24px!important;height:24px!important;cursor:nwse-resize!important;background:linear-gradient(135deg,transparent 50%,rgba(0,0,0,0.2) 50%)!important;border-radius:0 0 12px 0!important;z-index:10!important;touch-action:none!important;"></div>
        <div class="xb-so-resize-mobile" style="position:absolute!important;left:50%!important;bottom:0!important;transform:translateX(-50%)!important;width:60px!important;height:20px!important;cursor:ns-resize!important;display:none!important;align-items:center!important;justify-content:center!important;z-index:10!important;touch-action:none!important;"><div style="width:40px;height:4px;background:rgba(0,0,0,0.3);border-radius:2px;"></div></div>
    </div></div>`;
}

export const MOBILE_LAYOUT_STYLE = `position:absolute!important;left:0!important;right:0!important;top:0!important;bottom:auto!important;width:100%!important;height:60vh!important;transform:none!important;z-index:1!important;pointer-events:auto!important;border-radius:0 0 16px 16px!important;box-shadow:0 8px 32px rgba(0,0,0,.4)!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;background:#f4f4f4!important;`;

export const DESKTOP_LAYOUT_STYLE = `position:absolute!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;width:800px!important;max-width:90vw!important;height:600px!important;max-height:80vh!important;z-index:1!important;pointer-events:auto!important;border-radius:12px!important;box-shadow:0 8px 32px rgba(0,0,0,.4)!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;background:#f4f4f4!important;`;

