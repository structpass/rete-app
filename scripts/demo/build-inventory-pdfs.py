"""架空案件の実読可能なPDF資料を再作成する。アプリ実行時の依存ではない。"""
from pathlib import Path
import sys
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
body = ParagraphStyle("body", fontName="HeiseiKakuGo-W5", fontSize=10, leading=17, wordWrap="CJK", spaceAfter=10)
title = ParagraphStyle("title", parent=body, fontSize=18, leading=26, textColor=colors.HexColor("#17365D"), spaceAfter=15)
sub = ParagraphStyle("sub", parent=body, fontSize=12, leading=19, textColor=colors.HexColor("#17365D"), spaceBefore=10)

def make(name, heading, sections):
    flow = [Paragraph(heading,title),Paragraph("北斗機材 在庫管理システム導入 / 青凪システム<br/>2026年10月30日 / 架空案件の検証用資料",body),Spacer(1,12)]
    for h, paragraphs in sections:
        flow.append(Paragraph(h,sub))
        flow.extend(Paragraph(p,body) for p in paragraphs)
    def footer(canvas,doc):
        canvas.setFont("HeiseiKakuGo-W5",8)
        canvas.setFillColor(colors.HexColor("#64748B"))
        canvas.drawString(42,28,"架空の会社・人物・数値を用いたテストデータ")
        canvas.drawRightString(A4[0]-42,28,str(doc.page))
    SimpleDocTemplate(str(out/name),pagesize=A4,rightMargin=42,leftMargin=42,topMargin=40,bottomMargin=45).build(flow,onFirstPage=footer,onLaterPages=footer)

make("baseline.pdf","要件合意概要 第1.0版",[
 ("合意の位置付け",["10月30日の要件合意確認会で、北斗機材の石川真由・岡田智也・藤原美咲と、青凪システムの佐伯航・三浦彩が確認した設計の基準版です。基本設計は11月4日から開始します。"]),
 ("対象と対象外",["本社倉庫と南物流センターを対象に、入荷、出荷、在庫照会、倉庫間移動、棚卸を導入します。商品マスタ受領件数は18,420件。購買発注と請求は今回の範囲に含めません。"]),
 ("確定した業務ルール",["R-012：出荷可能数は実在庫から引当済を引きます。実在庫120、引当済35なら85。入荷予定40と移送中10は別表示し、出荷可能数へ加算しません。","R-018：倉庫間移動は出庫と受入を分けます。出庫時に元棚から減算、受入時に先棚へ加算します。移送中の二重計上と二重受入を防ぎます。","R-020：棚卸は対象棚だけを凍結し、対象外の棚は継続します。差異反映は責任者が承認します。","R-023：受注番号と明細番号で重複を判定します。CSVは全行検証後、ファイル単位で登録し、不正行の読み飛ばしはしません。"]),
 ("設計で具体化すること",["画面配置、入力文言、現行コードの対応を仕様確認事項一覧Q-001～Q-008で扱います。業務要件の追加・変更は、影響と対応時期を確認する変更相談に分けます。"]),
 ("予定",["11月6日・13日に顧客レビュー、11月20日に基本設計の承認確認。詳細設計は11月24日から12月11日。資料は各回の前営業日17時までに共有します。"]),
])
make("review.pdf","第1回 設計レビュー確認資料",[
 ("開催と確認すること",["11月6日（金）14:00～15:30。参加予定：石川真由、岡田智也、藤原美咲、佐伯航、三浦彩、森田悠。合意済みの要件を、実際に操作する画面と表示内容へ具体化します。"]),
 ("前半：在庫照会 S-03",["商品検索→商品合計→倉庫別→棚・ロット別の順で確認します。実在庫、引当済、出荷可能数を同じ行で確認し、入荷予定と移送中を分けます。Q-002では倉庫未選択時の配置案を確認します。"]),
 ("後半：入荷登録 S-01",["全量入荷だけでなく、部分入荷と数量差異を確認します。未入荷残数を残す表示、差異理由の言葉、ロット対象商品の未入力時の案内を、Q-004～Q-006で確認します。"]),
 ("事前に用意する資料",["青凪システム：画面一覧第0.9版、仕様確認事項一覧、在庫数量の確認例。11月5日17時までに共有。北斗機材：個人情報を除いた棚番・入荷伝票・出荷指示書の見本。"]),
 ("確認結果の残し方",["回答者、合意内容、担当タスク、回答期限を確認事項一覧へ反映します。決まっていないことは未回答として残し、合意済みと混同しません。追加要件はその場で実施決定せず変更相談へ回します。"]),
])
print("PDF 2件を作成")
