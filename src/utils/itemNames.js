// ============================================================
// 物品中文名 ⇄ 英文 ID 对照（给 !取 / !存箱 这类指令用中文输入）
//
// 为什么需要这个表：
//   · minecraft-data 里只有英文 displayName（"Iron Ingot"），没有中文；
//   · mineflayer 的 item.displayName 来自服务器下发语言，中文服上虽然是「铁锭」，
//     但那是"显示"用的，不能拿来做匹配依据（服务器语言一变就失效）。
//   所以这里内置一份常用物品的中英对照，用中文名直接匹配。
//
// 匹配规则（宽松，容错）：
//   1) 先按英文 ID 精确匹配（iron_ingot）
//   2) 再按中文名精确匹配（铁锭）
//   3) 最后按中文名模糊匹配（"铁" → 能匹配到含"铁"的物品；多个命中时给候选提示）
//   另外去空白、统一全角半角，避免中文输入法带来的空格差异。
//
// 想补充物品：直接在 对照表 里加一行 "英文ID": "中文名" 即可。
// ============================================================
'use strict'

// 常用物品对照（覆盖挂机场景里最常存取的：矿物、方块、食物、工具、材料）
const 对照表 = {
  // —— 矿物与锭 ——
  diamond: '钻石', emerald: '绿宝石', gold_ingot: '金锭', iron_ingot: '铁锭',
  copper_ingot: '铜锭', netherite_ingot: '下界合金锭', netherite_scrap: '下界合金碎片',
  coal: '煤炭', charcoal: '木炭', redstone: '红石', lapis_lazuli: '青金石',
  quartz: '下界石英', amethyst_shard: '紫水晶碎片', raw_iron: '粗铁', raw_gold: '粗金',
  raw_copper: '粗铜', flint: '燧石', gunpowder: '火药', blaze_rod: '烈焰棒',
  ender_pearl: '末影珍珠', ghast_tear: '恶魂之泪', nether_star: '下界之星',
  iron_nugget: '铁粒', gold_nugget: '金粒',

  // —— 常见方块 ——
  cobblestone: '圆石', stone: '石头', dirt: '泥土', grass_block: '草方块',
  coarse_dirt: '砂土', rooted_dirt: '缠根泥土', podzol: '灰化土', mycelium: '菌丝体',
  sand: '沙子', red_sand: '红沙', gravel: '沙砾', sandstone: '砂岩',
  clay: '黏土', clay_ball: '黏土球', obsidian: '黑曜石',
  cobbled_deepslate: '深板岩圆石', deepslate: '深板岩', tuff: '凝灰岩',
  granite: '花岗岩', diorite: '闪长岩', andesite: '安山岩', calcite: '方解石',
  netherrack: '下界岩', soul_sand: '灵魂沙', soul_soil: '灵魂土', basalt: '玄武岩',
  blackstone: '黑石', end_stone: '末地石', moss_block: '苔藓块',
  oak_log: '橡木原木', spruce_log: '云杉原木', birch_log: '白桦原木',
  jungle_log: '丛林原木', acacia_log: '金合欢原木', dark_oak_log: '深色橡木原木',
  oak_planks: '橡木木板', spruce_planks: '云杉木板', birch_planks: '白桦木板',
  stick: '木棍', torch: '火把', crafting_table: '工作台', furnace: '熔炉',
  chest: '箱子', barrel: '木桶', trapped_chest: '陷阱箱', hopper: '漏斗',
  glass: '玻璃', sand_stone: '砂岩', bricks: '红砖块', snowball: '雪球',
  ice: '冰', packed_ice: '浮冰', blue_ice: '蓝冰', sponge: '海绵',
  hay_block: '干草捆', wheat: '小麦', wheat_seeds: '小麦种子',
  bone_meal: '骨粉', bone: '骨头', string: '线', feather: '羽毛',
  leather: '皮革', paper: '纸', book: '书', sugar_cane: '甘蔗',
  bamboo: '竹子', kelp: '海带', dried_kelp: '干海带', seagrass: '海草',

  // —— 食物 ——
  bread: '面包', apple: '苹果', golden_apple: '金苹果',
  enchanted_golden_apple: '附魔金苹果', cooked_beef: '牛排', beef: '生牛肉',
  cooked_porkchop: '熟猪排', porkchop: '生猪排', cooked_chicken: '熟鸡肉',
  chicken: '生鸡肉', cooked_mutton: '熟羊肉', mutton: '生羊肉',
  cooked_cod: '熟鳕鱼', cod: '生鳕鱼', cooked_salmon: '熟鲑鱼', salmon: '生鲑鱼',
  carrot: '胡萝卜', golden_carrot: '金胡萝卜', potato: '马铃薯',
  baked_potato: '烤马铃薯', beetroot: '甜菜根', melon_slice: '西瓜片',
  sweet_berries: '甜浆果', cookie: '曲奇', cake: '蛋糕', pumpkin_pie: '南瓜派',
  rotten_flesh: '腐肉', spider_eye: '蜘蛛眼', poisonous_potato: '毒马铃薯',
  pufferfish: '河豚', tropical_fish: '热带鱼', mushroom_stew: '蘑菇煲',
  honey_bottle: '蜂蜜瓶', milk_bucket: '奶桶',

  // —— 工具与装备 ——
  wooden_pickaxe: '木镐', stone_pickaxe: '石镐', iron_pickaxe: '铁镐',
  golden_pickaxe: '金镐', diamond_pickaxe: '钻石镐', netherite_pickaxe: '下界合金镐',
  wooden_axe: '木斧', stone_axe: '石斧', iron_axe: '铁斧',
  golden_axe: '金斧', diamond_axe: '钻石斧', netherite_axe: '下界合金斧',
  wooden_shovel: '木锹', stone_shovel: '石锹', iron_shovel: '铁锹',
  diamond_shovel: '钻石锹', netherite_shovel: '下界合金锹',
  wooden_sword: '木剑', stone_sword: '石剑', iron_sword: '铁剑',
  golden_sword: '金剑', diamond_sword: '钻石剑', netherite_sword: '下界合金剑',
  bow: '弓', crossbow: '弩', arrow: '箭', spectral_arrow: '光灵箭',
  shield: '盾牌', fishing_rod: '钓鱼竿', flint_and_steel: '打火石',
  shears: '剪刀', bucket: '桶', water_bucket: '水桶', lava_bucket: '岩浆桶',
  milk_bucket_2: '奶桶', compass: '指南针', clock: '时钟', spyglass: '望远镜',
  elytra: '鞘翅', totem_of_undying: '不死图腾',

  // —— 盔甲 ——
  leather_helmet: '皮革帽子', leather_chestplate: '皮革外套', leather_leggings: '皮革裤子', leather_boots: '皮革靴子',
  chainmail_helmet: '锁链头盔', chainmail_chestplate: '锁链胸甲', chainmail_leggings: '锁链护腿', chainmail_boots: '锁链靴子',
  iron_helmet: '铁头盔', iron_chestplate: '铁胸甲', iron_leggings: '铁护腿', iron_boots: '铁靴子',
  golden_helmet: '金头盔', golden_chestplate: '金胸甲', golden_leggings: '金护腿', golden_boots: '金靴子',
  diamond_helmet: '钻石头盔', diamond_chestplate: '钻石胸甲', diamond_leggings: '钻石护腿', diamond_boots: '钻石靴子',
  netherite_helmet: '下界合金头盔', netherite_chestplate: '下界合金胸甲',
  netherite_leggings: '下界合金护腿', netherite_boots: '下界合金靴子',
  turtle_helmet: '海龟壳',

  // —— 树苗与种植 ——
  oak_sapling: '橡树树苗', spruce_sapling: '云杉树苗', birch_sapling: '白桦树苗',
  jungle_sapling: '丛林树苗', acacia_sapling: '金合欢树苗', dark_oak_sapling: '深色橡树树苗',
  cherry_sapling: '樱花树苗', mangrove_propagule: '红树胎生苗',

  // —— 其他常用 ——
  ender_chest: '末影箱', shulker_box: '潜影盒', anvil: '铁砧',
  enchanting_table: '附魔台', bookshelf: '书架', ladder: '梯子',
  oak_door: '橡木门', iron_door: '铁门', sign: '告示牌',
  bed: '床', red_bed: '红色床', white_bed: '白色床',
  map: '地图', filled_map: '地图', name_tag: '命名牌', saddle: '鞍',
  lead: '拴绳', experience_bottle: '附魔之瓶', ominous_bottle: '灾厄之瓶',
  netherite_upgrade: '下界合金升级模板', echo_shard: '回响碎片',
}

// 反查表：中文名 → 英文 ID（一个中文名只对应一个 ID，除非重名）
const 反查表 = new Map()
for (const [英文, 中文] of Object.entries(对照表)) {
  if (!反查表.has(中文)) 反查表.set(中文, 英文)
}

// 归一化输入：去首尾空白、去内部空格、全角转半角、英文转小写
function 归一输入 (输入) {
  let s = String(输入 == null ? '' : 输入).trim()
  // 全角字母数字 → 半角
  s = s.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  // 去内部空白（中文输入法常带空格，如「铁 锭」）
  s = s.replace(/\s+/g, '')
  return s.toLowerCase()
}

/**
 * 把用户输入的物品名解析成英文 ID
 * @param {string} 输入 中文名、英文 ID，或它们的片段
 * @returns {{ok:true, id:string, via:'英文ID'|'中文名'|'模糊'}|{ok:false, 候选:string[]}}
 */
function 解析物品名 (输入) {
  const 原 = String(输入 == null ? '' : 输入).trim()
  if (!原) return { ok: false, 候选: [] }
  const 键 = 归一输入(原)

  // ① 英文 ID 精确匹配（含下划线，直接就是 ID）
  if (/^[a-z0-9_]+$/.test(键) && 对照表[键]) return { ok: true, id: 键, via: '英文ID' }

  // ② 中文名精确匹配
  for (const [中文, 英文] of 反查表) {
    if (归一输入(中文) === 键) return { ok: true, id: 英文, via: '中文名' }
  }

  // ③ 模糊匹配：中文名包含输入，或输入包含中文名
  const 候选 = []
  for (const [中文, 英文] of 反查表) {
    const 键中文 = 归一输入(中文)
    if (键中文.includes(键) || 键.includes(键中文)) 候选.push(中文)
  }
  if (候选.length === 1) return { ok: true, id: 反查表.get(候选[0]), via: '模糊' }
  if (候选.length > 1) return { ok: false, 候选: 候选.slice(0, 8) }

  // ④ 也允许英文 ID 的片段（如 "iron" → iron_ingot/iron_sword…）
  const 英文候选 = Object.keys(对照表).filter(k => k.includes(键))
  if (英文候选.length === 1) return { ok: true, id: 英文候选[0], via: '模糊' }
  if (英文候选.length > 1) return { ok: false, 候选: 英文候选.slice(0, 8).map(k => `${k}（${对照表[k]}）`) }

  return { ok: false, 候选: [] }
}

// 英文 ID → 中文名（回执里显示用；表里没有就原样返回 ID）
function 取中文名 (英文ID) {
  const 键 = 归一输入(英文ID)
  return 对照表[键] || String(英文ID || '')
}

// 表里有多少条
function 条目数 () { return Object.keys(对照表).length }

module.exports = { 解析物品名, 取中文名, 条目数, 对照表, 归一输入 }
