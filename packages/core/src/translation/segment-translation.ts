// 定稿段翻译的平台无关编排：三端（macOS 主进程 / Web / iOS 桥接）共用同一套
// 「要不要翻 → pending → 引擎调用 → 字形归一化 → 回填/失败标记」流程，只把引擎调用
// 本身（本地模型 / 云端 / 原生框架，各端传输方式不同）留给调用方注入。
//
// 单条翻译的成败全部经 per-line 的译文事件表达（pending / 最终结果 / failed），
// 不触碰全局引擎状态通道——onTranslationStatus 的 error 专指引擎级故障
// （模型加载失败、进程崩溃等），由各端引擎自身上报。
import { langIdentity, planTranslation, type LocalModelSpec } from './local-spec';
import type { TranslationPayload } from '../types';
import type { TranslationContext } from './context';

/** Legacy callers without targetLang may keep session-local history for auto reverse translation. */
export interface ReverseTranslationContext {
  /** 上一次识别到的非母语源语言短码；null=本次会话尚未听到任何外语。 */
  lastForeignLang: string | null;
}

/** 新建一个反向翻译会话状态（初始无外语历史）。 */
export function createReverseTranslationContext(): ReverseTranslationContext {
  return { lastForeignLang: null };
}

/** 重置反向翻译状态：外语历史只在本次会话内有效，新录音会话开始时调用清空。 */
export function resetReverseTranslationContext(ctx: ReverseTranslationContext): void {
  ctx.lastForeignLang = null;
}

// 文字系统护栏用的判定：假名（平/片/音标扩展/半角）只出现在日语，谚文只出现在韩语；
// 中英文文本不含二者，故据此修正语种是零误伤的。纯汉字文本 zh/ja/yue 无法从文字系统
// 分辨，保持模型判定不动。
const KANA_RE = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏]/;

/**
 * 按文本的文字系统修正 ASR 检测语种（只做确定性修正）。
 * SenseVoice auto 模式对短段/强切段的语种误判是已定性的主要错误来源，误判会沿翻译链路
 * 放大成可见故障：日语段被误标成母语 zh 时，反向翻译把它按「zh→上一次外语(ja)」送翻，
 * 引擎对已是日语的文本原样吐回，UI 出现「译文=原文」的怪行。
 */
export function guardAsrLang(text: string, lang: string): string {
  if (KANA_RE.test(text)) return 'ja';
  if (HANGUL_RE.test(text)) return 'ko';
  return lang;
}

/** 注入给平台引擎的一次翻译请求。 */
export interface SegmentTranslateRequest {
  onPartial?: (text: string) => void;
  context?: string[];
  /** 行 id，译文异步回填对应 */
  id: number;
  /** 源文本（定稿段原文） */
  text: string;
  /** ASR 源语言短码（zh/en/ja/ko/yue） */
  source: string;
  /** 目标 app 语言键（zh/ja/en/ko）：能感知语言的引擎（本地模型映射 / 云端提示词）用它 */
  targetLang: string;
  /** 目标的模型短码（M2M100: zh/en/…）：只认短码的引擎（如 iOS 原生框架）用它 */
  targetCode: string;
}

export interface TranslateFinalizedSegmentOptions {
  context?: TranslationContext;
  spec: LocalModelSpec;
  segment: { id: number; text: string; lang: string };
  /** 翻译是否开启（关闭时不发任何事件） */
  enabled: boolean;
  /** 旧调用的默认目标语言；显式 targetLang 优先 */
  nativeLang: string;
  /** 显式目标语言；传入后固定翻译方向，不使用反向翻译历史。 */
  targetLang?: string;
  /** 未提供 targetLang 时，auto 可启用旧的反向翻译策略。 */
  asrLanguage?: string;
  /** 仅供未提供 targetLang 的旧调用使用；历史在新会话开始时清空。 */
  reverse?: ReverseTranslationContext;
  /** 平台引擎调用：把 text 翻成目标语言，失败抛错 */
  translate: (req: SegmentTranslateRequest) => Promise<string>;
  /** 译文事件（pending / 最终结果 / failed），三端分别接 IPC / 回调 */
  emitTranslation: (p: TranslationPayload) => void;
}

/** Explicit targets stay fixed; callers without one retain the legacy reverse-translation policy. */
function resolveTargetLang(opts: TranslateFinalizedSegmentOptions, sourceLang: string): string {
  if (opts.targetLang) return opts.targetLang;
  const isForeign = langIdentity(opts.spec, sourceLang) !== langIdentity(opts.spec, opts.nativeLang);
  if (isForeign) {
    if (opts.reverse) opts.reverse.lastForeignLang = sourceLang;
    return opts.nativeLang;
  }
  // 源是母语：auto 模式且有外语历史时反向翻译到上一次外语，否则仍以母语为目标（→ skip/script）。
  if (opts.asrLanguage === 'auto' && opts.reverse?.lastForeignLang) {
    return opts.reverse.lastForeignLang;
  }
  return opts.nativeLang;
}

/**
 * 对一条定稿段执行完整翻译编排（fire-and-forget，失败不影响转写）。优先使用显式目标；
 * 未提供目标的旧调用可通过 auto 与 reverse 状态启用反向翻译。
 * - `skip`：不发任何事件（不显示译文、不触发等待动画）。
 * - `script`：仅简繁字形不同，直接产出转换后的原文，不经引擎。
 * - `translate`：先发 pending（UI 显示等待动画），引擎产出后套 plan.toScript 做目标
 *   字形归一化（幂等，引擎已自行处理也不受影响）再回填；失败发 failed 事件，
 *   结束该行等待动画并在该行显示失败标记。
 */
export async function translateFinalizedSegment(
  opts: TranslateFinalizedSegmentOptions,
): Promise<void> {
  const { segment } = opts;
  if (!opts.enabled) return;

  // 先过文字系统护栏修正明显的语种误判，再解析翻译目标——误判的母语标记会触发错误的
  // 反向翻译（译文=原文回显），误判的外语标记会污染 lastForeignLang。
  const sourceLang = guardAsrLang(segment.text, segment.lang);
  // 目标语言解析须在任何 await 之前同步完成（reverse 状态按段序累计）。
  const targetLang = resolveTargetLang(opts, sourceLang);
  const plan = planTranslation(opts.spec, sourceLang, targetLang, segment.text);
  if (plan.kind === 'skip') {
    opts.context?.reset();
    return;
  }
  if (plan.kind === 'script') {
    opts.context?.reset();
    opts.emitTranslation({ id: segment.id, text: plan.text });
    return;
  }

  opts.emitTranslation({ id: segment.id, text: '', pending: true });
  let settled = false;
  try {
    const text = await opts.translate({
      id: segment.id,
      text: segment.text,
      onPartial: (partial) => {
        if (!settled && partial.trim()) opts.emitTranslation({ id: segment.id,
          text: plan.toScript ? plan.toScript(partial) : partial, partial: true });
      },
      source: sourceLang,
      targetLang: plan.targetLang,
      targetCode: plan.targetCode,
      ...(opts.context ? { context: opts.context.take(sourceLang, plan.targetLang, segment.text) } : {}),
    });
    settled = true;
    opts.emitTranslation({ id: segment.id, text: plan.toScript ? plan.toScript(text) : text });
  } catch (e) {
    settled = true;
    opts.emitTranslation({
      id: segment.id,
      text: '',
      failed: true,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
