/**
 * Prisma schema の enum と @rete/shared の const 配列（値の SSOT）が食い違ったら CI で落とすための検査
 * （cmn-0222・cmn-0198 の Quality cycle 退避項目1）。
 *
 * cmn-0198 で値の置き場を shared へ 1 本化したが、DB 側の真の定義は schema.prisma の enum であり、
 * 両者がズレても型エラーにはならない（schema に値を足しても shared は無言のまま／逆も同様）。実害は
 * 「DB には入りうる値を API が @IsIn で弾く／弾けない」の非対称で、気づくのが遅れると判定に響く。
 * ここは人の注意力ではなく機械で落とす。
 *
 * 【現在の登録ペアはゼロ】ADR 0063（fil-0136）で旧 FB+ の folder 権限 enum 2 種を撤去し、
 * 唯一の登録ペア 2 組が無くなった。harness（登録簿 + 2 種の検査）は残してあるので、新しい
 * 「Prisma enum ↔ shared 定数」の組が出たら PARITY_REGISTRY へ 1 行足すだけで検査が復帰する。
 *
 * 【既知の限界】
 * - 新しいペアを「登録し忘れた」ことは検出しない（schema.prisma の全 enum と shared 定数の対応を
 *   機械推定する規則が定まらないため。必要になったら別チケットで扱う）。
 * - 突き合わせ相手は schema.prisma のテキストではなく**生成済み @prisma/client** と shared の dist。CI は
 *   prisma generate → shared build → backend test の順が担保されている（.github/workflows/test.yml）。
 *   手元では backend/package.json の `pretest` が、生成物が schema.prisma より古い時に限り generate を先に
 *   走らせるため（d893）、schema を編集して generate を忘れた状態での誤緑経路は塞がれている。
 * - migration SQL 側（CREATE TYPE / ALTER TYPE ... ADD VALUE）のドリフトは対象外。schema と shared に値を
 *   足して migration を書き忘れた場合に落ちるのは cmn-0246 で scripts/check-constraint-drift.mjs へ
 *   追加した checkEnumDrift() 側（CI 先頭で常時実行・migration 全体 ↔ schema.prisma を突き合わせる）。
 * - Prisma の `@map` 付き enum 値（値名と DB 実値が異なる形）は検知できない（現状 @map の使用はゼロ）。
 */

interface ParityPair {
  name: string;
  prismaEnum: Record<string, string>;
  sharedConst: readonly string[];
}

/** 値のズレを守る Prisma enum ↔ shared 定数のペア。新しい組はここへ 1 行足す。 */
const PARITY_REGISTRY: readonly ParityPair[] = [];

describe('Prisma enum ↔ @rete/shared 定数の同値保証', () => {
  // it.each は空配列で例外になるため、登録簿の走査は 1 本の it の中で回す（ペアが 1 組でも
  // 入れば下の 2 種の検査がそのまま効く）。
  it('登録済みペアの値集合が完全一致し、キーと値も一致する', () => {
    for (const { sharedConst, prismaEnum } of PARITY_REGISTRY) {
      // 並び順は shared 側が UI の選択肢順を兼ねるため一致を要求しない（集合として突き合わせる）。
      expect([...sharedConst].sort()).toEqual(Object.values(prismaEnum).sort());
      // 綴りズレの検知（Prisma enum はキーと値が同一である前提）。
      for (const [key, value] of Object.entries(prismaEnum)) {
        expect(value).toBe(key);
      }
    }
    expect(PARITY_REGISTRY).toBeDefined();
  });
});
