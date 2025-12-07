// Story Outline 提示词模板配置
// 统一 UAUA (User-Assistant-User-Assistant) 结构

const PROMPT_STORAGE_KEY = 'LittleWhiteBox_StoryOutline_CustomPrompts';

// ================== 辅助函数 ==================
const wrap = (tag, content) => content ? `<${tag}>\n${content}\n</${tag}>` : '';
const worldInfo = `<world_info>\n{{description}}{$worldInfo}\n</world_info>`;
const history = n => `<chat_history>\n{$history${n}}\n</chat_history>`;
const nameList = (contacts, strangers) => {
    const names = [...(contacts || []).map(c => c.name), ...(strangers || []).map(s => s.name)];
    return names.length ? `\n\n**已存在角色（不要重复）：** ${names.join('、')}` : '';
};
const randomRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const safeJson = fn => { try { return fn(); } catch { return null; } };

// 导出兼容函数
export const buildSmsHistoryContent = t => t ? `<已有短信>\n${t}\n</已有短信>` : '<已有短信>\n（空白，首次对话）\n</已有短信>';
export const buildExistingSummaryContent = t => t ? `<已有总结>\n${t}\n</已有总结>` : '<已有总结>\n（空白，首次总结）\n</已有总结>';

// ================== JSON 模板（用户可自定义） ==================
const DEFAULT_JSON_TEMPLATES = {
    invite: `{
  "cot": "思维链：分析角色当前的处境、与玩家的关系、对邀请地点的看法...",
  "invite": true,
  "reply": "角色用自己的语气写的回复短信内容（10-50字）"
}`,

    npc: `{
  "name": "角色全名",
  "aliases": ["别名1", "别名2", "英文名/拼音"],
  "intro": "一句话的外貌与职业描述，用于列表展示。",
  "background": "简短的角色生平。解释由于什么过去导致了现在的性格，以及他为什么会出现在当前场景中。",
  "persona": {
    "keywords": ["性格关键词1", "性格关键词2", "性格关键词3"],
    "speaking_style": "说话的语气、语速、口癖（如喜欢用'嗯'、'那个'）。对待玩家的态度（尊敬、蔑视、恐惧等）。",
    "motivation": "核心驱动力（如：金钱、复仇、生存）。行动的优先级准则。"
  },
  "game_data": {
    "stance": "核心态度·具体表现。例如：'中立·唯利是图'、'友善·盲目崇拜' 或 '敌对·疯狂'",
    "secret": "该角色掌握的一个关键信息、道具或秘密。必须结合'剧情大纲'生成，作为一个潜在的剧情钩子。"
  }
}`,
    
    stranger: `[{ "name": "角色名", "location": "当前地点", "info": "一句话简介" }]`,
    
    // ===== 剧情模式：世界生成 / 推演 / 场景切换 =====
    worldGen: `{
  "meta": {
    "truth": {
      "overview": "一句话概括核心真相",
      "onion_layers": {
        "L1_Surface": [
          { "desc": "表象/传闻（公众视角的流言或误解）", "logic": "该传闻背后的实际情况" },
          { "desc": "...", "logic": "..." },
          { "desc": "...", "logic": "..." }
        ],
        "L2_Traces": [
          { "desc": "物理线索/物证（具体的物品/伤痕/信件）", "logic": "该线索揭示的信息" },
          { "desc": "...", "logic": "..." },
          { "desc": "...", "logic": "..." }
        ],
        "L3_Mechanism": [
          { "desc": "运作机制（连接表象与核心的中间环节/组织/规律）", "logic": "如何指向核心" },
          { "desc": "...", "logic": "..." }
        ],
        "L4_Nodes": [
          { "desc": "关键地点/代理人（不一定是反派，可能是关键NPC）", "logic": "在此事件中的作用" },
          { "desc": "...", "logic": "..." }
        ],
        "L5_Core": { "desc": "核心源头（人/物/怪/概念/思潮等）", "logic": "拥有的能力或影响力" },
        "L6_Drive": { "desc": "核心驱动力", "logic": "为何产生此驱动力（爱/恨/生存/贪婪/自然法则/社会转变等）" },
        "L7_Consequence": { "desc": "无人干涉时的最终局面", "logic": "如果不处理会导致什么" }
      }
    },
    "outcomes": {
      "default_end": "顺其自然的结局描述，可能较消极",
      "intervention_end": "玩家部分介入后的中性结局",
      "resolution_end": "完美解决或彻底颠覆的结局"
    }
  },
  "timeline": [
    { "stage": 0, "state": "初始状态", "event": "当前发生的标志性事件" },
    { "stage": 1, "state": "发展状态", "event": "..." }
  ],
  "world": {
    "news": [
      { "title": "新闻标题1", "time": "时间", "content": "反映世界观的简短内容" },
      { "title": "新闻标题2", "time": "...", "content": "..." },
      { "title": "新闻标题3", "time": "...", "content": "..." }
    ]
  },
  "maps": {
    "outdoor": {
      "description": "全景描写，必须包含所有节点名称，并用 [[名字]] 包裹",
      "nodes": [
        { 
          "name": "地点名", 
          "position": "north/south/east/west/northeast/southwest/northwest/southeast", 
          "distant": 1/2/3/4/5, 
          "type": "main/sub/home", 
          "info": "地点特征与氛围,可能（或许没有）与剧情的关联",
        }
      ]
    }
  }
    }`,
    
    worldSim: `{
  "meta": {
    "truth": {
      "overview": "保持核心真相不变，但根据形势微调描述",
      "onion_layers": {
        "L1_Surface": [
          { "desc": "更新后的流言（反映当前乱象或新进展）", "logic": "..." },
          { "desc": "...", "logic": "..." },
          { "desc": "...", "logic": "..." }
        ],
        "L2_Traces": [
          { "desc": "新的物理线索（旧的可能已被发现或销毁）", "logic": "..." },
          { "desc": "...", "logic": "..." },
          { "desc": "...", "logic": "..." }
        ],
        "L3_Mechanism": [
          { "desc": "运作机制的变化（如：组织收缩防线/扩张）", "logic": "..." },
          { "desc": "...", "logic": "..." }
        ],
        "L4_Nodes": [
          { "desc": "关键地点/代理人的新动向", "logic": "..." },
          { "desc": "...", "logic": "..." }
        ],
        "L5_Core": { "desc": "保持不变（除非被玩家击破）", "logic": "保持不变" },
        "L6_Drive": { "desc": "保持不变", "logic": "保持不变" },
        "L7_Consequence": { "desc": "保持不变", "logic": "保持不变" }
      }
    },
    "outcomes": {
      "default_end": "保持不变",
      "intervention_end": "根据玩家近期行为微调",
      "resolution_end": "保持不变"
    }
  },
  "timeline": [
    { "stage": 0 "state": "初始状态", "event": "发生的标志性事件" },
    { "stage": 1, "state": "演化后的新状态", "event": "新爆发的大事件" },
    { "stage": 2, "state": "演化后的新状态", "event": "爆发的大事件" },
    { "stage": 3, "state": "...", "event": "..." },
  ],
  "world": {
    "news": [
      { "title": "新的头条", "time": "推演后的时间", "content": "反映L1/L2层面的变动" },
      { "title": "...", "time": "...", "content": "..." },
      { "title": "...", "time": "...", "content": "..." }
    ]
  },
  "maps": {
    "outdoor": {
      "description": "更新后的全景描写（体现环境恶化/重建/变化），包含所有节点 [[名字]]",
      "nodes": [
        { 
          "name": "地点名 (Main节点保持，Sub节点可能变更)", 
          "position": "保持原方位，north/south/east/west/northeast/southwest/northwest", 
          "distant": 1/2/3/4/5 (Main节点保持，约30%的Sub节点变更)", 
          "type": "main/sub/home", 
          "info": "全新的环境描述（反映时间流逝/战火/玩家破坏后的痕迹）,些微可能与剧情相关",
        }
      ]
    }
  }
    }`,
    
    sceneSwitch: `{
  "review": {
    "deviation": {
      "cot_analysis": "思维链：简要分析玩家在上一地点的最后行为是否改变了剧情走向",
      "score_delta": 基于思维链的偏差值（0-4无关/5-10干扰/11-20转折）,
      "prev_loc_update": "描述玩家离开后，上一地点发生的环境或氛围变化（沉浸式描写）"
    }
  },
  "scene_setup": {
    "side_story": {
      "story": "基于提取的 L 级元素生成的本场景独有剧情",
      "surface": "玩家刚进入时能看到的表层钩子（如：奇怪的声音/丢失的物品）",
      "inner": "通过调查可发现的里层真相（对应大纲中的 L 级秘密）"
    },
    "local_map": {
      "name": "地点名称",
      "description": "全景描写，必须包含所有 nodes 的 [[节点名]]",
      "nodes": [
        {
          "name": "节点名",
          "position": "north/south/east/west/northeast/southwest/northwest",
          "distant": 1,
          "type": "main/sub",
          "info": "节点的微观描写（如：布满灰尘的桌面）"
        }
      ]
    },
    "strangers": [
      {
        "name": "NPC名称",
        "location": "当前所处节点",
        "info": "外貌与氛围，正在做什么"
      }
    ]
  }
}`,

    // ===== 辅助模式：只负责地图/新闻/轻剧情，不写大纲与时间线 =====
    // 世界生成（辅助模式）：不要求 meta / timeline，重点生成 world.news + maps
    worldGenAssist: `{
  "meta": null,
  "timeline": [],
  "world": {
    "news": [
      { "title": "新闻标题1", "time": "时间", "content": "以轻松日常的口吻描述世界现状" },
      { "title": "新闻标题2", "time": "...", "content": "可以是小道消息、趣闻轶事" },
      { "title": "新闻标题3", "time": "...", "content": "..." }
    ]
  },
  "maps": {
    "outdoor": {
      "description": "全景描写，聚焦氛围与可探索要素。所有可去节点名用 [[名字]] 包裹。",
      "nodes": [
        {
          "name": "地点名",
          "position": "north/south/east/west/northeast/southwest/northwest/southeast",
          "distant": 1,
          "type": "main/sub/home",
          "info": "地点特征与氛围，适合作为舞台的小事件或偶遇"
        }
      ]
    }
  }
}`,

    // 世界推演（辅助模式）：只更新 world.news 与 maps 描述，不动 meta/timeline（可为空）
    worldSimAssist: `{
  "meta": null,
  "timeline": [],
  "world": {
    "news": [
      { "title": "新的头条", "time": "推演后的时间", "content": "用轻松/中性的语气，描述世界最近发生的小变化" },
      { "title": "...", "time": "...", "content": "比如店家打折、节庆活动、某个 NPC 的日常糗事" },
      { "title": "...", "time": "...", "content": "..." }
    ]
  },
  "maps": {
    "outdoor": {
      "description": "更新后的全景描写，体现日常层面的变化（装修、节日装饰、天气等），包含所有节点 [[名字]]。",
      "nodes": [
        {
          "name": "地点名（尽量沿用原有命名，如有变化保持风格一致）",
          "position": "保持原大致方位，如 north/south/east/west/northeast/southwest/northwest",
          "distant": 1,
          "type": "main/sub/home",
          "info": "新的环境描写。偏生活流，只讲玩家能直接感受到的变化"
        }
      ]
    }
  }
}`,

    // 场景切换（辅助模式）：生成一小段小剧情 + 局部地图
    sceneSwitchAssist: `{
  "review": {
    "deviation": {
      "cot_analysis": "简要分析玩家在上一地点的行为对氛围的影响（例如：让气氛更热闹/更安静）。",
      "score_delta": 0,
      "prev_loc_update": "用一两句话描写玩家离开后，上一地点的小变化（如：灯光变暗、客人散去、音乐声渐弱）。"
    }
  },
  "scene_setup": {
    "side_story": {
      "story": "一小段日常的小剧情。可以是偶遇、误会互动等。",
      "surface": "玩家刚进入时看到的画面或听到的话语，充满生活感。",
      "inner": "如果玩家稍微多停留或互动，可以发现的细节（例如 NPC 的小秘密、店家的用心布置）。"
    },
    "local_map": {
      "name": "当前地点名称",
      "description": "局部地点的全景描写，适合展开小事件的舞台；包含所有 nodes 的 [[节点名]]。",
      "nodes": [
        {
          "name": "节点名",
          "position": "north/south/east/west/northeast/southwest/northwest",
          "distant": 1,
          "type": "main/sub",
          "info": "该节点当前正在发生的一幕，比如聊天、摆摊、闲逛等场景"
        }
      ]
    },
    "strangers": [
      {
        "name": "NPC名称",
        "location": "当前所在节点名",
        "info": "外貌与氛围，正在做的事情。偏向日常"
      }
    ]
  }
}`
};
export let JSON_TEMPLATES = { ...DEFAULT_JSON_TEMPLATES };

// ================== 提示词配置（用户可自定义） ==================
// 每个配置：[u1, a1, u2, a2] 对应 UAUA 四个消息
const DEFAULT_PROMPTS = {
    // 1. 短信回复
    sms: {
        u1: v => `现在是短信模拟场景。\n\n${wrap('story_outline', v.storyOutline)}${v.storyOutline ? '\n\n' : ''}${worldInfo}\n\n${history(v.historyCount)}\n\n以上是设定和聊天历史，遵守人设，忽略规则类信息和非${v.contactName}经历的内容。以${v.contactName}身份回复${v.userName}的短信（仅输出回复内容）。字数精简，10～30字左右。${v.characterContent ? `\n\n<${v.contactName}的人物设定>\n${v.characterContent}\n</${v.contactName}的人物设定>` : ''}`,
        a1: v => `明白，我只输出${v.contactName}的回复短信，请提供已有短信历史。`,
        u2: v => `${v.smsHistoryContent}\n\n<${v.userName}发来的新短信>\n${v.userMessage}`,
        a2: v => `了解，开始以${v.contactName}进行回复:`
    },
    
    // 2. 总结压缩
    summary: {
        u1: () => `你是剧情记录员。根据新短信聊天内容提取新增剧情要素。\n\n任务：只根据新对话输出增量内容，不重复已有总结。\n事件筛选：只记录有信息量的完整事件。`,
        a1: () => `明白，我只输出新增内容，请提供已有总结和新对话内容。`,
        u2: v => `${v.existingSummaryContent}

<新对话内容>
${v.conversationText}
</新对话内容>

输出要求：
- 只输出一个合法 JSON 对象
- 使用标准 JSON 语法：所有键名和字符串都使用半角双引号 "
- 文本内容中如需使用引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "

格式示例：{"summary": "角色A向角色B打招呼，并表示会守护在旁边"}`,
        a2: () => `了解，开始生成JSON:`
    },
    
    // 3. 邀请回复
    invite: {
        u1: v => `你是短信模拟器。${v.userName}正在邀请${v.contactName}前往「${v.targetLocation}」。\n\n${wrap('story_outline', v.storyOutline)}${v.storyOutline ? '\n\n' : ''}${worldInfo}\n\n${history(v.historyCount)}${v.characterContent ? `\n\n<${v.contactName}的人物设定>\n${v.characterContent}\n</${v.contactName}的人物设定>` : ''}\n\n根据${v.contactName}的人设、处境、与${v.userName}的关系，判断是否答应。\n\n**判断参考**：亲密度、当前事务、地点危险性、角色性格\n\n输出JSON："cot"(思维链)、"invite"(true/false)、"reply"(10-50字回复)\n\n要求：\n- 返回一个合法 JSON 对象\n- 使用标准 JSON 语法：所有键名和字符串都使用半角双引号 "\n- 文本内容中如需使用引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "\n\n模板：${JSON_TEMPLATES.invite}`,
        a1: v => `明白，我将分析${v.contactName}是否答应并以角色语气回复。请提供短信历史。`,
        u2: v => `${v.smsHistoryContent}\n\n<${v.userName}发来的新短信>\n我邀请你前往「${v.targetLocation}」，你能来吗？`,
        a2: () => `了解，开始生成JSON:`
    },
    
    // 4. NPC生成
    npc: {
        u1: v => `你是TRPG角色生成器。将陌生人【${v.strangerName} - ${v.strangerInfo}】扩充为完整NPC。基于世界观和剧情大纲，输出严格JSON。`,
        a1: () => `明白。请提供上下文，我将严格按JSON输出，不含多余文本。`,
        u2: v => `${worldInfo}\n\n${history(v.historyCount)}\n\n剧情秘密大纲（*从这里提取线索赋予角色秘密*）：\n${wrap('story_outline', v.storyOutline) || '<story_outline>\n(无)\n</story_outline>'}\n\n需要生成：【${v.strangerName} - ${v.strangerInfo}】\n\n输出要求：\n1. 必须是合法 JSON\n2. 使用标准 JSON 语法：所有键名和字符串都使用半角双引号 "\n3. 文本字段（intro/background/persona/game_data 等）中，如需表示引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "\n4. aliases须含简称或绰号\n\n模板：${JSON_TEMPLATES.npc}`,
        a2: () => `了解，开始生成JSON:`
    },
    
    // 5. 提取陌路人
    stranger: {
        u1: () => `你是TRPG数据整理助手。从剧情文本中提取玩家遇到的陌生人/NPC，整理为JSON数组。`,
        a1: () => `明白。请提供【世界观】和【剧情经历】，我将提取角色并以JSON数组输出。`,
        u2: v => `### 上下文\n\n**1. 世界观：**\n${worldInfo}\n\n**2. 玩家经历：**\n${history(v.historyCount)}${v.storyOutline ? `\n\n**剧情大纲：**\n${wrap('story_outline', v.storyOutline)}` : ''}${nameList(v.existingContacts, v.existingStrangers)}\n\n### 输出要求\n\n1. 返回一个合法 JSON 数组，使用标准 JSON 语法（键名和字符串都用半角双引号 "）\n2. 只提取有具体称呼的角色\n3. 每个角色只需 name / location / info 三个字段\n4. 文本内容中如需使用引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "\n5. 无新角色返回 []\n\n模板：${JSON_TEMPLATES.stranger}`,
        a2: () => `了解，开始生成JSON:`
    },
    
    // 6. 世界生成（故事模式）
    worldGen: {
        u1: () => `你是TRPG动态叙事引擎。根据【题材风格】构建逻辑自洽、曲折吸引人的初始剧情状态。

核心原则：
1. **自适应基调**：分析题材风格(恐怖→不可知,日常→羁绊,脑洞→反直觉)。严禁轻松题材强制引入灾难。
2. **真相结构**（L1-L7）：表象→痕迹→机制→节点→核心→驱动→后果
3. **时间轴**：${randomRange(4, 7)}个阶段，演变符合题材
4. **结局**：Default/Intervention/Resolution
5. **世界**：News至少${randomRange(3, 7)}条，Maps至少${randomRange(7, 15)}个地点
6. **历史参考**：参考玩家经历构建世界

输出：仅纯净合法 JSON，禁止解释文字或Markdown。
- 使用标准 JSON 语法：所有键名和字符串都使用半角双引号 "
- 文本内容中如需使用引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "`,
        a1: () => `明白。我将分析题材风格，遵循L1→L7模型构建JSON。请提供设定。`,
        u2: v => `【世界观与要求】：\n${worldInfo}\n\n【玩家经历参考】：\n${history(v.historyCount)}\n\n【玩家要求】：\n${v.playerRequests || '无特殊要求'}\n\n【JSON模板】：\n${JSON_TEMPLATES.worldGen}`,
        a2: () => `严格生成JSON，不擅自修改。JSON生成开始:`
    },
    
    // 7. 世界推演（故事模式）
    worldSim: {
        u1: () => `你是世界演化引擎。推动时间流逝，根据【玩家历史行为】和【既定命运】计算世界下一状态。

演化逻辑：
1. **历史回顾**：分析玩家行为影响（摧毁据点→变废墟，忽略威胁→恶化）
2. **真相迭代**：L5-L7保持不变；L1-L2大幅更新；L3-L4适度更新
3. **地图重构**：Main保留原名更新info；约30%的Sub结构性变化/删减/增加, 保证至少有${randomRange(7, 15)}个地点存在
4. **时间推进**：Stage推进，生成全新News，至少${randomRange(3, 7)}个新闻
5. **时间线微调**：timeline根据现状微调现在和未来的推算

输出：完整 JSON，结构与模板一致，禁止解释文字。
- 使用标准 JSON 语法：所有键名和字符串都使用半角双引号 "
- 文本内容中如需使用引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "`,
        a1: () => `明白。我将读取当前状态和玩家历史，推演变化。保留核心，更新30%次级节点，刷新新闻和浅层线索。请提供数据。`,
        u2: v => `【世界观设定】：\n${worldInfo}\n\n【玩家历史】：\n${history(v.historyCount)}\n\n【当前世界状态】：\n${v.currentWorldData || '{}'}\n\n【JSON模板】：\n${JSON_TEMPLATES.worldSim}`,
        a2: () => `演化计算完成。JSON output start:`
    },
    
    // 8. 场景切换（故事模式）
    sceneSwitch: {
        u1: v => {
            const lLevel = v.targetLocationType === 'main'
                ? Math.min(7, v.stage + 2) // 主节点：使用当前 stage + 2 的深度
                : v.targetLocationType === 'sub'
                    ? 2 // 次级节点：日常气氛，浅层（L2）
                    : Math.min(7, v.stage + 1);
            return `你是TRPG场景管理器。处理玩家移动请求，结算上一地点后果，构建新地点场景。

处理逻辑：
1. **历史结算**：分析玩家最后行为，计算偏差值(0-4无关/5-10干扰/11-20转折)，描述离开后地点变化
2. **故事生成**：用L${lLevel}级元素生成Side Story（表层钩子+里层真相）。若地点类型为 sub，请写日常气氛/生活流，与主线关联度低。
3. **局部地图**：Description全景式描写，节点用[[名]]包裹；生成${randomRange(4, 7)}个节点和0-3个NPC

输出：仅符合模板的 JSON，禁止解释文字。
- 使用标准 JSON 语法：所有键名和字符串都使用半角双引号 "
- 文本内容中如需使用引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "`;
        },
        a1: v => {
            const lLevel = v.targetLocationType === 'main'
                ? Math.min(7, v.stage + 2)
                : v.targetLocationType === 'sub'
                    ? 2
                    : Math.min(7, v.stage + 1);
            return `明白。我将结算偏差值，基于L${lLevel}深度生成Side Story和局部地图JSON。sub 类型将写成日常/支线，弱关联主线。请发送上下文。`;
        },
        u2: v => `【上一地点】：\n${v.prevLocationName}: ${v.prevLocationInfo || '无详细信息'}\n\n【世界设定】：\n${worldInfo}\n\n【剧情大纲】：\n${wrap('story_outline', v.storyOutline) || '无大纲'}\n\n【当前时间段】：\n${v.currentTimeline ? `Stage ${v.currentTimeline.stage}: ${v.currentTimeline.state} - ${v.currentTimeline.event}` : `Stage ${v.stage}`}\n\n【历史记录】：\n${history(v.historyCount)}\n\n【玩家行动意图】：\n${v.playerAction || '无特定意图'}\n\n【目标地点】：\n名称: ${v.targetLocationName}\n类型: ${v.targetLocationType}\n描述: ${v.targetLocationInfo || '无详细信息'}\n\n【JSON模板】：\n${JSON_TEMPLATES.sceneSwitch}`,
        a2: () => `OK, JSON generate start:`
    },

    // 9. 世界生成（辅助模式，仅地图/新闻，不写大纲与时间线）
    worldGenAssist: {
        u1: () => `你是世界观布景助手。负责搭建【地图】和【世界新闻】等可见表层信息。

核心要求：
1. 给出可探索的舞台
2. 重点是：有氛围、有地点、有事件线索，但不过度“剧透”故事
3. **世界**：News至少${randomRange(3, 7)}条，Maps至少${randomRange(7, 15)}个地点
4. **历史参考**：参考玩家经历构建世界

输出：仅纯净合法 JSON，结构参考模板 worldGenAssist。
- 使用标准 JSON 语法：所有键名和字符串都使用半角双引号 "
- 文本内容中如需使用引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "`,
        a1: () => `明白。我将只生成世界新闻与地图信息。`,
        u2: v => `【世界观与要求】：
${worldInfo}

【玩家经历参考】：
${history(v.historyCount)}

【玩家需求】：
${v.playerRequests || '无特殊要求'}

【JSON模板（辅助模式）】：
${JSON_TEMPLATES.worldGenAssist}`,
        a2: () => `严格按 worldGenAssist 模板生成JSON，仅包含 world/news 与 maps/outdoor:`
    },

    // 10. 世界推演（辅助模式，只更新地图/新闻，忽略大纲与时间线）
    worldSimAssist: {
        u1: () => `你是世界状态更新助手。根据当前 JSON 的 world/maps 和玩家历史，轻量更新世界现状。

输出：完整 JSON，结构参考 worldSimAssist 模板，禁止解释文字。`,
        a1: () => `明白。我将只更新 world.news 和 maps.outdoor，不写大纲与时间线。请提供当前世界数据。`,
        u2: v => `【世界观设定】：
${worldInfo}

【玩家历史】：
${history(v.historyCount)}

【当前世界状态JSON】（可能包含 meta/timeline/world/maps 等字段）：
${v.currentWorldData || '{}'}

【JSON模板（辅助模式）】：
${JSON_TEMPLATES.worldSimAssist}`,
        a2: () => `开始按 worldSimAssist 模板输出JSON:`
    },

    // 11. 场景切换（辅助模式，小剧情 + 局部地图）
    sceneSwitchAssist: {
        u1: v => `你是TRPG场景小助手。处理玩家从一个地点走向另一个地点，只生成日常向的小剧情与局部地图。

处理逻辑：
1. 上一地点结算：简要描述玩家离开后的小变化（比如人群散去、音乐声改变），不讨论命运走向
2. 新地点氛围：围绕 "${v.targetLocationName}" 塑造一个适合事件的场景（如小店、街角、校园一隅）
3. 小剧情：生成一段可以马上开玩的剧情（偶遇、误会、闲聊、任务起点等）
4. 局部地图：为该地点生成数个可互动节点（nodes），每个节点可以看作一个“拍摄镜头”或小舞台

输出：仅符合 sceneSwitchAssist 模板的 JSON，禁止解释文字。
- 使用标准 JSON 语法：所有键名和字符串都使用半角双引号 "
- 文本内容中如需使用引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "`,
        a1: () => `明白。我会生成小剧情与局部地图。请发送上下文。`,
        u2: v => `【上一地点】：
${v.prevLocationName}: ${v.prevLocationInfo || '无详细信息'}

【世界设定】：
${worldInfo}

【玩家行动意图】：
${v.playerAction || '无特定意图'}

【目标地点】：
名称: ${v.targetLocationName}
类型: ${v.targetLocationType}
描述: ${v.targetLocationInfo || '无详细信息'}

【已有聊天与剧情历史】：
${history(v.historyCount)}

【JSON模板（辅助模式）】：
${JSON_TEMPLATES.sceneSwitchAssist}`,
        a2: () => `OK, sceneSwitchAssist JSON generate start:`
    }
};
export let PROMPTS = { ...DEFAULT_PROMPTS };

const serializePrompts = prompts => Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, {
    u1: v.u1?.toString?.() || '',
    a1: v.a1?.toString?.() || '',
    u2: v.u2?.toString?.() || '',
    a2: v.a2?.toString?.() || ''
}]));

const compileFn = (src, fallback) => {
    if (!src) return fallback;
    try {
        const fn = eval(`(${src})`);
        return typeof fn === 'function' ? fn : fallback;
    } catch {
        return fallback;
    }
};

const hydratePrompts = promptSources => {
    const out = {};
    Object.entries(DEFAULT_PROMPTS).forEach(([k, v]) => {
        const src = promptSources?.[k] || {};
        out[k] = {
            u1: compileFn(src.u1, v.u1),
            a1: compileFn(src.a1, v.a1),
            u2: compileFn(src.u2, v.u2),
            a2: compileFn(src.a2, v.a2)
        };
    });
    return out;
};

const applyPromptConfig = cfg => {
    if (cfg?.jsonTemplates) JSON_TEMPLATES = { ...DEFAULT_JSON_TEMPLATES, ...cfg.jsonTemplates };
    else JSON_TEMPLATES = { ...DEFAULT_JSON_TEMPLATES };
    PROMPTS = hydratePrompts(cfg?.promptSources || cfg?.prompts);
};

const loadPromptConfigFromStorage = () => safeJson(() => JSON.parse(localStorage.getItem(PROMPT_STORAGE_KEY)));
const savePromptConfigToStorage = cfg => { try { localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(cfg)); } catch {} };

export const getPromptConfigPayload = () => ({
    current: { jsonTemplates: JSON_TEMPLATES, promptSources: serializePrompts(PROMPTS) },
    defaults: { jsonTemplates: DEFAULT_JSON_TEMPLATES, promptSources: serializePrompts(DEFAULT_PROMPTS) }
});

export const setPromptConfig = (cfg, persist = false) => {
    applyPromptConfig(cfg || {});
    const payload = { jsonTemplates: JSON_TEMPLATES, promptSources: serializePrompts(PROMPTS) };
    if (persist) savePromptConfigToStorage(payload);
    return payload;
};

export const reloadPromptConfigFromStorage = () => {
    const saved = loadPromptConfigFromStorage();
    if (saved) applyPromptConfig(saved);
    else applyPromptConfig();
    return getPromptConfigPayload().current;
};

reloadPromptConfigFromStorage();

// ================== 通用构建函数 ==================
const build = (type, vars) => {
    const p = PROMPTS[type];
    return [
        { role: 'user', content: p.u1(vars) },
        { role: 'assistant', content: p.a1(vars) },
        { role: 'user', content: p.u2(vars) },
        { role: 'assistant', content: p.a2(vars) }
    ];
};

// ================== 导出构建函数 ==================
export const buildSmsMessages = v => build('sms', v);
export const buildSummaryMessages = v => build('summary', v);
export const buildInviteMessages = v => build('invite', v);
export const buildNpcGenerationMessages = v => build('npc', v);
export const buildExtractStrangersMessages = v => build('stranger', v);
// 根据 mode 选择故事模式或辅助模式的提示词
export const buildWorldGenMessages = v => build(v?.mode === 'assist' ? 'worldGenAssist' : 'worldGen', v);
export const buildWorldSimMessages = v => build(v?.mode === 'assist' ? 'worldSimAssist' : 'worldSim', v);
export const buildSceneSwitchMessages = v => build(v?.mode === 'assist' ? 'sceneSwitchAssist' : 'sceneSwitch', v);

// ================== NPC 格式化 ==================
export function formatNpcToWorldbookContent(npc) {
    const lines = [`【${npc.name}】`];
    if (npc.aliases?.length) lines.push(`别名：${npc.aliases.join('、')}`);
    lines.push('');
    if (npc.intro) lines.push(`外貌/职业：${npc.intro}`, '');
    if (npc.background) lines.push(`背景：${npc.background}`, '');
    if (npc.persona) {
        lines.push('性格特征：');
        const { keywords, speaking_style, motivation } = npc.persona;
        if (keywords?.length) lines.push(`- 关键词：${keywords.join('、')}`);
        if (speaking_style) lines.push(`- 说话风格：${speaking_style}`);
        if (motivation) lines.push(`- 行动动机：${motivation}`);
        lines.push('');
    }
    if (npc.game_data) {
        lines.push('游戏相关：');
        if (npc.game_data.stance) lines.push(`- 阵营态度：${npc.game_data.stance}`);
        if (npc.game_data.secret) lines.push(`- 隐藏秘密：${npc.game_data.secret}`);
    }
    return lines.join('\n').trim();
}

// ================== Overlay HTML ==================
const FRAME_STYLE = 'position:absolute!important;z-index:1!important;pointer-events:auto!important;border-radius:12px!important;box-shadow:0 8px 32px rgba(0,0,0,.4)!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;background:#f4f4f4!important;';

export const buildOverlayHtml = src => `<div id="xiaobaix-story-outline-overlay" style="position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:99999!important;display:none;overflow:hidden!important;pointer-events:none!important;">
<div class="xb-so-frame-wrap" style="${FRAME_STYLE}">
<div class="xb-so-drag-handle" style="position:absolute!important;top:0!important;left:0!important;width:200px!important;height:48px!important;z-index:10!important;cursor:move!important;background:transparent!important;touch-action:none!important;"></div>
<iframe id="xiaobaix-story-outline-iframe" class="xiaobaix-iframe" src="${src}" style="width:100%!important;height:100%!important;border:none!important;background:#f4f4f4!important;"></iframe>
<div class="xb-so-resize-handle" style="position:absolute!important;right:0!important;bottom:0!important;width:24px!important;height:24px!important;cursor:nwse-resize!important;background:linear-gradient(135deg,transparent 50%,rgba(0,0,0,0.2) 50%)!important;border-radius:0 0 12px 0!important;z-index:10!important;touch-action:none!important;"></div>
<div class="xb-so-resize-mobile" style="position:absolute!important;left:50%!important;bottom:0!important;transform:translateX(-50%)!important;width:60px!important;height:20px!important;cursor:ns-resize!important;display:none!important;align-items:center!important;justify-content:center!important;z-index:10!important;touch-action:none!important;"><div style="width:40px;height:4px;background:rgba(0,0,0,0.3);border-radius:2px;"></div></div>
</div></div>`;

export const MOBILE_LAYOUT_STYLE = 'position:absolute!important;left:0!important;right:0!important;top:0!important;bottom:auto!important;width:100%!important;height:60vh!important;transform:none!important;z-index:1!important;pointer-events:auto!important;border-radius:0 0 16px 16px!important;box-shadow:0 8px 32px rgba(0,0,0,.4)!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;background:#f4f4f4!important;';

export const DESKTOP_LAYOUT_STYLE = 'position:absolute!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;width:800px!important;max-width:90vw!important;height:600px!important;max-height:80vh!important;z-index:1!important;pointer-events:auto!important;border-radius:12px!important;box-shadow:0 8px 32px rgba(0,0,0,.4)!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;background:#f4f4f4!important;';
