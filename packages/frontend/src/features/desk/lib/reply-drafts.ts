/**
 * 書きかけの返信本文をテーマごとに保持する置き場（d737）。返信欄はテーマ切替（スレッド一覧→詳細の往復）と
 * 起点カードの編集開始（返信欄のアンマウント）で消えるため、書きかけはテーマ id ごとにここへ残し、戻った時に
 * 復元する（開発統括回答『残して戻れる形にする』/ d729）。
 *
 * - モジュールスコープ（メモリ内）に持つ。他テーマを開いて戻る・画面遷移して戻る（アプリのシェルが生きて
 *   いる間）のどちらでも復元できる。再読み込みをまたぐ永続は持たない（保持はセッション内に閉じる）。
 * - 空 HTML（''・'<p></p>' 等）は未入力とみなして捨てる（空の下書きを積まない）。
 * - 上限は件数・1 件の文字数で打ち切る（開き続けてもメモリが膨らまない）。超えた時は古い順に捨てる。
 */

/** 保持する下書きの上限件数。 */
export const MAX_REPLY_DRAFTS = 30;

/** 1 件の下書きの上限文字数（これを超える本文は保持しない）。 */
export const MAX_REPLY_DRAFT_LENGTH = 20000;

const drafts = new Map<string, string>();

/** 空本文（タグだけ・空白だけの HTML 含む）か。 */
export function isBlankDraft(body: string): boolean {
  if (!body) return true;
  const text = body
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return text.length === 0;
}

/** 書きかけ本文を保持する。空・上限超過は捨てる（上限超過は保持しない＝古い書きかけを守る）。 */
export function writeReplyDraft(themeId: string, body: string): void {
  if (!themeId) return;
  if (isBlankDraft(body)) {
    drafts.delete(themeId);
    return;
  }
  if (body.length > MAX_REPLY_DRAFT_LENGTH) {
    drafts.delete(themeId);
    return;
  }
  // 書き込みのたびに末尾へ移し、上限を超えたら最も古いものから捨てる（Map は挿入順）。
  drafts.delete(themeId);
  drafts.set(themeId, body);
  while (drafts.size > MAX_REPLY_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

/** 保持している書きかけ本文（無ければ undefined）。 */
export function readReplyDraft(themeId: string): string | undefined {
  return drafts.get(themeId);
}

/** 保持件数（検査用）。 */
export function replyDraftCount(): number {
  return drafts.size;
}

/** 全て捨てる（ログアウト時・検査用。別アカウントへ書きかけを見せない）。 */
export function clearAllReplyDrafts(): void {
  drafts.clear();
}
