// File タブの公開境界。ページからは合成済みの FilesView のみを使う
// （サイドバーと本体シェルの共有状態を FilesView 内に閉じ込めるため、個別 export はしない）。
export { FilesView } from './components/files-view';
// お気に入り★（Home のサイドバー・shell）が、同じ URL への押し直しを File 画面へ伝える入口（d560）。
// shell から本 feature の内部（hooks/lib）へ直接触れずに済むよう、ここだけを公開する。
export { unlockFileLink } from './hooks/use-file-id-from-location';
