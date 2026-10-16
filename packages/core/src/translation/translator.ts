// 翻译能力的抽象层：上层只依赖 Translator 接口，具体用哪个本地模型 / 云 API 由各端工厂决定。
// 这里只放平台无关的契约；工厂（createTranslator）与本地模型实现留在各端。

export interface TranslateProgress {
  /** 如 "initiate" / "download" / "progress" / "done" / "ready" */
  status: string;
  /** 当前文件的百分比（0~100，单文件） */
  progress?: number;
  /** 正在下载的文件名 */
  file?: string;
  /** 当前文件已下载字节 */
  loaded?: number;
  /** 当前文件总字节 */
  total?: number;
}

export interface Translator {
  /** 懒加载模型，首次翻译前调用；重复调用应是幂等的 */
  init(onProgress?: (p: TranslateProgress) => void): Promise<void>;
  /**
   * 把 text 翻成 target 语言。source 缺省时由实现决定如何处理。
   * 语言码用 SenseVoice 风格的短码：zh / en / ja / ko / yue。
   */
  translate(text: string, opts: { source?: string; target: string; context?: string[]; onPartial?: (text: string) => void }): Promise<string>;
}
