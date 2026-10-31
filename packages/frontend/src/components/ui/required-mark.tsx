/**
 * 「* 必須」マーク。サーバが空を拒否する項目に出す（正本 comp-form-field の必須バッジと同字面・同色）。
 *
 * マークはラベル要素の外（隣）に置く＝アクセシブル名を変えない。見た目だけのマークなので
 * aria-hidden にし、必須の意味は入力側の aria-required が担う。
 * 手組みの複製が画面ごとに散っていたものを 1 つに集約する（d687）。
 */
export function RequiredMark() {
  return (
    <span className="sp-required-mark" aria-hidden="true">
      <span className="sp-required-star">*</span> 必須
    </span>
  );
}
