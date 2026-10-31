'use client';

import { useCallback, useEffect, useState } from 'react';
import { extractErrorMessage, extractValidationErrorMessage } from '@/lib/error-utils';
import {
  fetchFileSettings,
  updateFileSettings,
  normalizeExtension,
  parseExtensions,
  clampSizeMb,
} from '../lib/api';
import type { FileSettingsForm } from '../lib/api';

/**
 * 保存結果。失敗時はサーバーが返した検証理由（日本語）を reason に載せる（v2-198）。
 * 固定文言だけを出すと呼び出し側が理由を補えず、どの欄の何を直せばよいか画面から分からなくなる。
 */
export type FileSettingsSaveResult = { ok: true } | { ok: false; reason: string };

/** 拡張子1件の追加結果（画面が「入った / 入らなかった」を出し分けるための戻り値）。 */
export type AddExtensionResult = 'added' | 'duplicate' | 'invalid';

export interface UseFileSettingsResult {
  loading: boolean;
  saving: boolean;
  error: boolean;
  /**
   * 読み込みに失敗した理由（サーバーが返した文言。取れなければ「設定の読み込みに失敗しました」）。
   * d754: 同じ設定を編集する2面（設定タブの画面と Files のオーバーレイ）が一律の文言で理由を捨てており、
   * 何を直せば開けるのか分からなかった。保存失敗で理由を出している扱い（v2-198）に揃える。
   */
  loadErrorReason: string;
  maxSizeMb: number;
  /**
   * 許可拡張子の一覧（v2-203）。以前は「カンマ区切りの入力欄テキスト」1本だったが、
   * 1件ずつ追加・解除する方式へ変えたため配列で保持する（表示はチップ、保存時にそのまま送る）。
   */
  allowedExtensions: string[];
  /**
   * 常に拒否する拡張子（v2-197 要求版2）。コード固定で編集対象外のため setter を持たず、
   * 追加・解除の操作対象にもならない（読み取り専用の表示に使う）。
   */
  fixedRejectedExtensions: string[];
  /** 追加で拒否する拡張子の一覧（v2-197・v2-203 で1件ずつの追加・解除へ変更）。 */
  rejectedExtensions: string[];
  setMaxSizeMb: (mb: number) => void;
  /** 許可拡張子を1件足す。空文字は invalid、既存（大文字小文字を問わない）は duplicate を返す。 */
  addAllowedExtension: (raw: string) => AddExtensionResult;
  /** 追加で拒否する拡張子を1件足す。判定は addAllowedExtension と同じ。 */
  addRejectedExtension: (raw: string) => AddExtensionResult;
  /** 許可拡張子を1件外す（表示上の解除。保存するまで確定しない）。 */
  removeAllowedExtension: (ext: string) => void;
  /** 追加で拒否する拡張子を1件外す。 */
  removeRejectedExtension: (ext: string) => void;
  /** 取得値（保存後は保存値）からの変更があるか。Esc 破棄確認の発火判定に使う（mdl-0034 規約②）。 */
  dirty: boolean;
  /** 保存して成功で { ok: true } / 失敗で { ok: false, reason } を返す（呼び出し側が toast / close を制御）。 */
  save: () => Promise<FileSettingsSaveResult>;
  /** 途中の追加・解除を破棄して取得値（保存後は保存値）へ戻す（v2-203 のキャンセル）。 */
  reset: () => void;
}

/** 拡張子配列の比較鍵（順序込み）。dirty 判定と reset の同一性確認に使う。 */
function sameExtensions(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * アップロード設定（最大サイズ / 許可拡張子 / 拒否する拡張子）の取得・編集・保存 hook。
 * マウント時（＝設定画面・設定オーバーレイ表示時）に現在値を取得し、フォーム state として保持する。
 * サイズは MB 単位、拡張子は配列のまま扱い、画面が1件ずつ追加・解除する（v2-203）。
 */
export function useFileSettings(): UseFileSettingsResult {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [loadErrorReason, setLoadErrorReason] = useState('');
  const [maxSizeMb, setMaxSizeMb] = useState(0);
  const [allowedExtensions, setAllowedExtensions] = useState<string[]>([]);
  const [fixedRejectedExtensions, setFixedRejectedExtensions] = useState<string[]>([]);
  const [rejectedExtensions, setRejectedExtensions] = useState<string[]>([]);
  // 変更比較・破棄の基準値（取得値 / 保存後は正規化済み保存値）。固定分は編集できないため比較に入れない。
  const [baseline, setBaseline] = useState<{
    maxSizeMb: number;
    allowedExtensions: string[];
    rejectedExtensions: string[];
  } | null>(null);

  const applyForm = useCallback(
    (form: { maxSizeMb: number; allowedExtensions: string[]; rejectedExtensions: string[] }) => {
      setMaxSizeMb(form.maxSizeMb);
      setAllowedExtensions([...form.allowedExtensions]);
      setRejectedExtensions([...form.rejectedExtensions]);
      setBaseline({
        maxSizeMb: form.maxSizeMb,
        allowedExtensions: [...form.allowedExtensions],
        rejectedExtensions: [...form.rejectedExtensions],
      });
    },
    [],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setLoadErrorReason('');
    fetchFileSettings()
      .then((form) => {
        if (!active) return;
        setFixedRejectedExtensions([...form.fixedRejectedExtensions]);
        applyForm(form);
      })
      .catch((err) => {
        if (!active) return;
        // 失敗の理由を捨てない（d754）。取れない失敗は固定文言へ縮退する（空の文言を出さない）。
        setLoadErrorReason(extractErrorMessage(err, '設定の読み込みに失敗しました'));
        setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applyForm]);

  /**
   * 入力1件を正規化して一覧へ足す。カンマ・空白区切りで複数書かれても1件ずつ受け取る
   * （貼り付けた「.pdf, .md」を取りこぼさない）。重複と空は足さず、理由を返す。
   *
   * 追加の有無は「今の値」に対して判定する。React の setter へ渡す関数は描画まで実行されない
   * ため、その中で結果を決めると戻り値（画面が出すメッセージ）が実際の反映とずれる。
   */
  const addExtension = useCallback(
    (
      raw: string,
      current: string[],
      setter: React.Dispatch<React.SetStateAction<string[]>>,
    ): AddExtensionResult => {
      const parsed = parseExtensions(raw);
      if (!parsed.length) return 'invalid';
      const added = parsed.filter((ext) => !current.includes(ext));
      if (!added.length) return 'duplicate';
      setter([...current, ...added]);
      // 既存分を除いた結果が空＝1件も入らなかった時だけ duplicate。一部でも入れば added。
      return added.length === parsed.length ? 'added' : 'duplicate';
    },
    [],
  );

  const addAllowedExtension = useCallback(
    (raw: string) => addExtension(raw, allowedExtensions, setAllowedExtensions),
    [addExtension, allowedExtensions],
  );
  const addRejectedExtension = useCallback(
    (raw: string) => addExtension(raw, rejectedExtensions, setRejectedExtensions),
    [addExtension, rejectedExtensions],
  );
  const removeAllowedExtension = useCallback((ext: string) => {
    setAllowedExtensions((prev) => prev.filter((x) => x !== ext));
  }, []);
  const removeRejectedExtension = useCallback((ext: string) => {
    setRejectedExtensions((prev) => prev.filter((x) => x !== ext));
  }, []);

  const save = useCallback(async (): Promise<FileSettingsSaveResult> => {
    setSaving(true);
    try {
      const form: FileSettingsForm = {
        maxSizeMb: clampSizeMb(maxSizeMb),
        allowedExtensions,
        fixedRejectedExtensions,
        rejectedExtensions,
      };
      const saved = await updateFileSettings(form);
      // 正規化後の保存値でフォームを揃える（拡張子の重複排除・小文字化を反映）。
      setFixedRejectedExtensions([...saved.fixedRejectedExtensions]);
      applyForm(saved);
      return { ok: true };
    } catch (err) {
      // サーバーが返した検証理由（details.validationErrors）を捨てない（v2-198）。
      return { ok: false, reason: extractValidationErrorMessage(err, '設定の保存に失敗しました') };
    } finally {
      setSaving(false);
    }
  }, [maxSizeMb, allowedExtensions, fixedRejectedExtensions, rejectedExtensions, applyForm]);

  /** 途中の追加・解除を破棄して基準値へ戻す（v2-203 のキャンセル。保存はしない）。 */
  const reset = useCallback(() => {
    if (!baseline) return;
    setMaxSizeMb(baseline.maxSizeMb);
    setAllowedExtensions([...baseline.allowedExtensions]);
    setRejectedExtensions([...baseline.rejectedExtensions]);
  }, [baseline]);

  const dirty =
    baseline !== null &&
    (maxSizeMb !== baseline.maxSizeMb ||
      !sameExtensions(allowedExtensions, baseline.allowedExtensions) ||
      !sameExtensions(rejectedExtensions, baseline.rejectedExtensions));

  return {
    loading,
    saving,
    error,
    loadErrorReason,
    maxSizeMb,
    allowedExtensions,
    fixedRejectedExtensions,
    rejectedExtensions,
    setMaxSizeMb,
    addAllowedExtension,
    addRejectedExtension,
    removeAllowedExtension,
    removeRejectedExtension,
    dirty,
    save,
    reset,
  };
}

/** 拡張子1件の表示形（入力が「xxxx」でも表示は「.xxxx」）。チップの文字列に使う。 */
export { normalizeExtension };
