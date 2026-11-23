import { unzipSync, strFromU8 } from "fflate";
import { normalizeImport } from "../shared/import.mjs";

const MAX_BYTES = 20 * 1024 * 1024;

export async function readHistoryFile(file) {
  if (!file) throw new Error("请选择聊天记录文件");
  if (file.size > MAX_BYTES)
    throw new Error("文件过大，请选择 20 MB 以内的记录");
  if (/\.zip$/i.test(file.name)) {
    let totalSize = 0;
    let jsonFiles = 0;
    let excluded = false;
    const paths = new Set();
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter(entry) {
        const path = entry.name.replace(/\\/g, "/").normalize("NFC");
        if (
          !path ||
          path.includes("\0") ||
          /^(?:\/|[a-z]:)/i.test(path) ||
          path.split("/").some((part) => part === "..")
        ) {
          throw new Error("压缩包包含不安全的文件路径，请使用原始导出文件");
        }
        if (paths.has(path))
          throw new Error("压缩包中存在重复的文件路径，请使用原始导出文件");
        paths.add(path);
        if (
          !/\.json$/i.test(entry.name) ||
          entry.name.startsWith("__MACOSX/")
        ) {
          excluded = true;
          return false;
        }
        totalSize += entry.originalSize;
        jsonFiles += 1;
        if (totalSize > MAX_BYTES || jsonFiles > 150)
          throw new Error("压缩包中的聊天记录过大，请分批导入");
        return true;
      },
    });
    const parsed = [];
    for (const [filename, bytes] of Object.entries(files)) {
      try {
        parsed.push({ filename, data: JSON.parse(strFromU8(bytes)) });
      } catch {
        throw new Error("压缩包中存在无法解析的 JSON：" + filename);
      }
    }
    if (!parsed.length) throw new Error("压缩包中没有可导入的聊天记录");
    const result = normalizeImport(parsed);
    if (excluded)
      result.warnings.push("本次仅迁移文字对话，图片和其他附件未导入。");
    return result;
  }
  if (!/\.(json|txt|md|markdown)$/i.test(file.name))
    throw new Error("支持 ZIP、JSON、TXT 或 Markdown 文件");
  return normalizeImport(await file.text());
}

export function readHistoryText(text) {
  return normalizeImport(text);
}
