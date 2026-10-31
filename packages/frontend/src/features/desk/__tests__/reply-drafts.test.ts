import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearAllReplyDrafts,
  isBlankDraft,
  MAX_REPLY_DRAFT_LENGTH,
  MAX_REPLY_DRAFTS,
  readReplyDraft,
  replyDraftCount,
  writeReplyDraft,
} from '../lib/reply-drafts';

// 書きかけの返信本文の保持（d737）。空判定・保持/復元・上限・破棄を単体で確かめる。
beforeEach(() => clearAllReplyDrafts());

describe('isBlankDraft — 空 HTML は未入力とみなす', () => {
  it('空文字・タグのみ・空白のみは空扱い', () => {
    expect(isBlankDraft('')).toBe(true);
    expect(isBlankDraft('<p></p>')).toBe(true);
    expect(isBlankDraft('<p><br></p>')).toBe(true);
    expect(isBlankDraft('<p>&nbsp;</p>')).toBe(true);
    expect(isBlankDraft('   ')).toBe(true);
  });

  it('文字が入っていれば空ではない', () => {
    expect(isBlankDraft('<p>書きかけ</p>')).toBe(false);
  });
});

describe('writeReplyDraft / readReplyDraft — テーマごとの保持と復元', () => {
  it('テーマごとに別々に保持し、読むと書いた本文が返る', () => {
    writeReplyDraft('t1', '<p>一件目</p>');
    writeReplyDraft('t2', '<p>二件目</p>');
    expect(readReplyDraft('t1')).toBe('<p>一件目</p>');
    expect(readReplyDraft('t2')).toBe('<p>二件目</p>');
    expect(readReplyDraft('t3')).toBeUndefined();
  });

  it('空にするとそのテーマの保持を捨てる（未入力の下書きを積まない）', () => {
    writeReplyDraft('t1', '<p>一件目</p>');
    writeReplyDraft('t1', '<p></p>');
    expect(readReplyDraft('t1')).toBeUndefined();
    expect(replyDraftCount()).toBe(0);
  });

  it('上限文字数を超える本文は保持しない', () => {
    writeReplyDraft('t1', 'あ'.repeat(MAX_REPLY_DRAFT_LENGTH + 1));
    expect(readReplyDraft('t1')).toBeUndefined();
  });

  it('上限件数を超えたら最も古い書きかけから捨てる（最近書いたものを残す）', () => {
    for (let i = 0; i < MAX_REPLY_DRAFTS + 2; i += 1) writeReplyDraft(`t${i}`, `<p>${i}</p>`);
    expect(replyDraftCount()).toBe(MAX_REPLY_DRAFTS);
    expect(readReplyDraft('t0')).toBeUndefined();
    expect(readReplyDraft('t1')).toBeUndefined();
    expect(readReplyDraft('t2')).toBe('<p>2</p>');
    expect(readReplyDraft(`t${MAX_REPLY_DRAFTS + 1}`)).toBe(`<p>${MAX_REPLY_DRAFTS + 1}</p>`);
  });

  it('同じテーマを書き直すと最近扱いに移る（更新したものは捨てられない）', () => {
    for (let i = 0; i < MAX_REPLY_DRAFTS; i += 1) writeReplyDraft(`t${i}`, `<p>${i}</p>`);
    writeReplyDraft('t0', '<p>updated</p>');
    writeReplyDraft('tn', '<p>new</p>');
    expect(readReplyDraft('t0')).toBe('<p>updated</p>');
    expect(readReplyDraft('t1')).toBeUndefined();
  });

  it('clearAllReplyDrafts ですべて捨てる（ログアウト時）', () => {
    writeReplyDraft('t1', '<p>a</p>');
    writeReplyDraft('t2', '<p>b</p>');
    clearAllReplyDrafts();
    expect(replyDraftCount()).toBe(0);
  });
});
