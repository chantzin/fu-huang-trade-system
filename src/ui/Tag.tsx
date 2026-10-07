import { html } from './format.ts';

// 標籤（對應舊 MJ.ui.tag）
export default function Tag({ text, type = 'gray' }: any) {
  return <span class={`tag t-${type}`} dangerouslySetInnerHTML={html(String(text))} />;
}
