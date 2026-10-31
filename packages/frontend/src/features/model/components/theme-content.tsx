import type { ContentBlock, ModelTheme, ThemeExample, ThemeRef } from '../types';
import { PageTitle } from '@/components/shared/page-title';
import { Badge } from '@/components/ui/badge';
import { DEMOS } from './demos';

/**
 * 実描画見本の枠（mdl-0011）。正例=teal / 悪例=red / 本文内見本=neutral の枠で、
 * 実物コンポーネントの描画領域をページ地の文から区別する。
 */
function DemoFrame({
  kind,
  caption,
  children,
}: {
  kind: 'good' | 'bad' | 'plain';
  caption?: string;
  children: React.ReactNode;
}) {
  const style = {
    good: {
      border: 'border-[var(--sp-accent-teal)]',
      label: '◯ 正しい例',
      labelCls: 'text-[var(--sp-accent-teal-strong)]',
    },
    bad: {
      border: 'border-[var(--sp-accent-red)]',
      label: '× だめな例',
      labelCls: 'text-[var(--sp-accent-red)]',
    },
    plain: {
      border: 'border-[var(--sp-line-warm)]',
      label: '実描画見本',
      labelCls: 'text-[var(--sp-text-warm-mute)]',
    },
  }[kind];
  return (
    <figure className={`overflow-hidden rounded-md border ${style.border}`}>
      {/* 装飾背景は --sp-paper。--sp-row-stripe は明細縞専用（ユーザーが OFF/変色できる）ため流用しない（mdl-0022） */}
      <figcaption
        className={`flex flex-wrap items-baseline gap-2 border-b border-[var(--sp-line-warm-2)] bg-[var(--sp-paper)] px-3 py-1 text-[0.6875rem] font-semibold ${style.labelCls}`}
      >
        {style.label}
        {caption && <span className="font-normal text-[var(--sp-text-warm-mute)]">{caption}</span>}
      </figcaption>
      <div className="bg-[var(--sp-paper)] p-4">{children}</div>
    </figure>
  );
}

/** registry キーから実描画見本を引いて描画する（未登録キーは manifest.test が検出する）。 */
function Demo({ demo }: { demo: string }) {
  const Comp = DEMOS[demo];
  if (!Comp) {
    // テストを経ないビルドで registry 欠落が「無言の空白」にならないよう開発時のみ警告する。
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[model] 未登録の demo キー: ${demo}`);
    }
    return null;
  }
  return <Comp />;
}

/** 構造化ブロック1件を固定 JSX で描画する（Markdown エンジンは使わない）。 */
function Block({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'p':
      return <p className="text-sm leading-relaxed text-[var(--sp-text-warm)]">{block.text}</p>;
    case 'list':
      return (
        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--sp-text-warm)]">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.8125rem]">
            <thead>
              <tr>
                {block.head.map((h, i) => (
                  <th
                    key={i}
                    className="border border-[var(--sp-line-warm)] bg-[var(--sp-paper-2)] px-2.5 py-1.5 text-left font-semibold text-[var(--sp-text-warm)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                // 明細の縞模様（偶数行 / --sp-row-stripe。mdl-0022）
                <tr key={ri} className="even:bg-[var(--sp-row-stripe)]">
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="border border-[var(--sp-line-warm)] px-2.5 py-1.5 align-top text-[var(--sp-text-warm-2)]"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-md border border-[var(--sp-line-warm)] bg-[var(--sp-paper)] p-3 text-[0.8125rem] leading-relaxed text-[var(--sp-text-warm)]">
          <code>{block.code}</code>
        </pre>
      );
    case 'note':
      return (
        <div className="rounded-md border-l-4 border-[var(--sp-accent-teal)] bg-[var(--sp-input-soft-blue-faint)] px-3 py-2 text-[0.8125rem] leading-relaxed text-[var(--sp-text-warm-2)]">
          {block.text}
        </div>
      );
    case 'demo':
      return (
        <DemoFrame kind="plain" caption={block.caption}>
          <Demo demo={block.demo} />
        </DemoFrame>
      );
    default:
      return null;
  }
}

/** セクション見出し + 中身（中身が空なら描画しない）。 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[0.8125rem] font-semibold uppercase tracking-wide text-[var(--sp-text-warm-mute)]">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 参照リスト（準拠先 / 関連ADR）。href があればリンク（外部は別タブ）。 */
function RefList({ refs }: { refs: ThemeRef[] }) {
  return (
    <ul className="space-y-1 text-sm text-[var(--sp-text-warm)]">
      {refs.map((ref, i) => (
        <li key={i} className="flex gap-1.5">
          <span aria-hidden className="text-[var(--sp-text-warm-mute)]">
            ↳
          </span>
          {ref.href ? (
            <a
              href={ref.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--sp-accent-ink)] underline-offset-2 hover:underline"
            >
              {ref.label}
            </a>
          ) : (
            <span>{ref.label}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 適用例/アンチパターンの1項目（◯/× の文 + 実描画見本）。
 * UI 系カテゴリの active テーマは demo 必須（manifest.test が機械強制・mdl-0011）。
 */
function Example({ kind, example }: { kind: 'good' | 'bad'; example: ThemeExample }) {
  const item = typeof example === 'string' ? { text: example } : example;
  return (
    <div className="space-y-2">
      <div className="flex gap-2 text-sm leading-relaxed text-[var(--sp-text-warm)]">
        <span
          aria-hidden
          className={`font-semibold ${kind === 'good' ? 'text-[var(--sp-accent-teal-strong)]' : 'text-[var(--sp-accent-red)]'}`}
        >
          {kind === 'good' ? '◯' : '×'}
        </span>
        <span>{item.text}</span>
      </div>
      {item.demo && (
        <DemoFrame kind={kind}>
          <Demo demo={item.demo} />
        </DemoFrame>
      )}
    </div>
  );
}

/** 1テーマの本文（目的/仕様/挙動/デザイン/準拠先/関連ADR/適用例）を描画する。 */
export function ThemeContent({ theme }: { theme: ModelTheme }) {
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header>
        {/* 見出しは共通 PageTitle（mdl-0028）。旧実装の font-bold と下区切り線は正本準拠のため撤去。 */}
        <PageTitle
          title={theme.title}
          after={theme.status === 'stub' ? <Badge variant="progress">整備中</Badge> : undefined}
        />
        <p className="text-sm text-[var(--sp-text-warm-2)]">{theme.summary}</p>
        {theme.sources.length > 0 && (
          <p className="mt-2 text-xs text-[var(--sp-text-warm-mute)]">
            移管元: {theme.sources.join(' / ')}
          </p>
        )}
      </header>

      <Section title="目的">
        <p className="text-sm leading-relaxed text-[var(--sp-text-warm)]">{theme.purpose}</p>
      </Section>

      {theme.spec.length > 0 && (
        <Section title="仕様">
          <div className="space-y-3">
            {theme.spec.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </div>
        </Section>
      )}

      {theme.behavior && theme.behavior.length > 0 && (
        <Section title="挙動">
          <div className="space-y-3">
            {theme.behavior.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </div>
        </Section>
      )}

      {theme.design && theme.design.length > 0 && (
        <Section title="デザイン">
          <div className="space-y-3">
            {theme.design.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </div>
        </Section>
      )}

      {theme.compliesWith && theme.compliesWith.length > 0 && (
        <Section title="準拠先">
          <RefList refs={theme.compliesWith} />
        </Section>
      )}

      {theme.relatedAdr && theme.relatedAdr.length > 0 && (
        <Section title="関連ADR">
          <RefList refs={theme.relatedAdr} />
        </Section>
      )}

      {theme.examples && (theme.examples.good?.length || theme.examples.bad?.length) ? (
        <Section title="適用例 / アンチパターン">
          <div className="space-y-3">
            {theme.examples.good?.map((ex, i) => (
              <Example key={`g${i}`} kind="good" example={ex} />
            ))}
            {theme.examples.bad?.map((ex, i) => (
              <Example key={`b${i}`} kind="bad" example={ex} />
            ))}
          </div>
        </Section>
      ) : null}
    </article>
  );
}
