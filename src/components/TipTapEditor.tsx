// TipTap 所見即所得編輯器（表單編輯用）
// - 支援工具列：標題／粗體／斜體／刪除線／清單／表格／對齊／圖片／插入系統欄位
// - 佔位符 {{欄位}} 以灰色標籤（token）顯示；儲存時輸出純文字 {{欄位}}，與舊資料及渲染端相容
import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { Editor } from '@tiptap/core';
import { Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';

/** 系統欄位 token（atom inline node）：編輯器中顯示為不可拆分的灰色標籤 */
const FieldToken = Node.create({
  name: 'fieldToken',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      field: {
        default: '',
        parseHTML: (el: any) => el.getAttribute('data-field') || '',
        renderHTML: (attrs: any) => ({ 'data-field': attrs.field }),
      },
    };
  },
  parseHTML() { return [{ tag: 'span[data-field]' }]; },
  renderHTML({ node }) {
    return ['span', { 'data-field': node.attrs.field, class: 'field-token' }, '{{' + node.attrs.field + '}}'];
  },
});

/** 純文字 {{欄位}} → span[data-field]（載入進編輯器前） */
const toEditor = (html: string) =>
  String(html || '').replace(/\{\{([^}]+)\}\}/g, (m, f) =>
    '<span data-field="' + f + '">{{' + f + '}}</span>');

/** span[data-field] → 純文字 {{欄位}}（儲存前，保持與舊資料相容） */
const fromEditor = (html: string) =>
  String(html || '').replace(/<span data-field="([^"]*)"[^>]*>\{\{([^}]*)\}\}<\/span>/g, (m, f) => '{{' + f + '}}');

interface TipTapEditorProps {
  value?: string;
  onChange?: (_html: string) => void;
  /** 欄位清單：[{ group, label, token }] 或既有分組格式 [{ group, fields:[{label,token}] }] */
  fields?: any[];
  minHeight?: number;
}

export default function TipTapEditor({ value = '', onChange, fields = [], minHeight = 280 }: TipTapEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const skipSync = useRef(false);
  const lastEmit = useRef('');

  // 工具列 active 狀態
  const bold = useSignal(false);
  const italic = useSignal(false);
  const strike = useSignal(false);
  const h1 = useSignal(false); const h2 = useSignal(false); const h3 = useSignal(false);
  const bullet = useSignal(false); const ordered = useSignal(false);
  const alignLeft = useSignal(true); const alignCenter = useSignal(false); const alignRight = useSignal(false);
  const fieldGroup = useSignal('');

  // 統一分組欄位清單（相容兩種格式）
  const grouped: any[] = (fields || []).map((g: any) =>
    Array.isArray(g.fields)
      ? { group: g.group, list: g.fields }
      : { group: g.group, list: [{ label: g.label, token: g.token }] });
  const currentGroup = grouped.find((g) => g.group === fieldGroup.value) || grouped[0] || { group: '', list: [] };
  if (!fieldGroup.value && grouped[0]) { /* 延遲到掛載後設定 */ }

  const syncActive = () => {
    const ed = editorRef.current; if (!ed) return;
    bold.value = ed.isActive('bold'); italic.value = ed.isActive('italic'); strike.value = ed.isActive('strike');
    h1.value = ed.isActive('heading', { level: 1 }); h2.value = ed.isActive('heading', { level: 2 }); h3.value = ed.isActive('heading', { level: 3 });
    bullet.value = ed.isActive('bulletList'); ordered.value = ed.isActive('orderedList');
    alignLeft.value = ed.isActive({ textAlign: 'left' }); alignCenter.value = ed.isActive({ textAlign: 'center' }); alignRight.value = ed.isActive({ textAlign: 'right' });
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ed = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        Table.configure({ resizable: true }),
        TableRow, TableCell, TableHeader,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Image.configure({ inline: false }),
        FieldToken,
      ],
      content: toEditor(value),
      onUpdate: () => {
        syncActive();
        if (!skipSync.current) {
          const html = fromEditor(ed.getHTML());
          if (html !== lastEmit.current) { lastEmit.current = html; onChange?.(html); }
        }
      },
      onSelectionUpdate: syncActive,
    });
    editorRef.current = ed;
    if (grouped.length && !fieldGroup.value) fieldGroup.value = grouped[0].group;
    syncActive();
    return () => { ed.destroy(); editorRef.current = null; };
  }, []);

  // 外部 value 變更（切模板／載入舊文件）→ 同步進編輯器
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const incoming = toEditor(value);
    if (incoming === ed.getHTML()) return;
    skipSync.current = true;
    ed.commands.setContent(incoming);
    skipSync.current = false;
    syncActive();
  }, [value]);

  const run = (fn: any) => () => { const ed = editorRef.current; if (!ed) return; fn(ed); };

  const btn = (active: boolean) =>
    `margin:0 2px;padding:4px 9px;font-size:12.5px;border:1px solid #d3d9e3;border-radius:6px;background:${active ? '#2d5a87' : '#fff'};color:${active ? '#fff' : '#333'};cursor:pointer;line-height:1.4;`;

  const insertField = (token: string) => {
    const ed = editorRef.current; if (!ed) return;
    ed.chain().focus().insertContent({ type: 'fieldToken', attrs: { field: token } }).run();
  };

  const insertTable = () => {
    const ed = editorRef.current; if (!ed) return;
    ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };
  const addTableRow = () => {
    const ed = editorRef.current; if (!ed) return;
    ed.chain().focus().addRowAfter().run();
  };
  const addTableCol = () => {
    const ed = editorRef.current; if (!ed) return;
    ed.chain().focus().addColumnAfter().run();
  };
  const deleteTable = () => {
    const ed = editorRef.current; if (!ed) return;
    if (ed.isActive('table') && confirm('確定刪除目前表格？')) ed.chain().focus().deleteTable().run();
  };
  const insertImage = () => {
    const ed = editorRef.current; if (!ed) return;
    const url = prompt('請輸入圖片網址（URL）');
    if (url) ed.chain().focus().setImage({ src: url }).run();
  };

  return (
    <div class="tiptap-wrap">
      <div class="tiptap-toolbar">
        <button style={btn(h1.value)} onClick={run((ed: any) => ed.chain().focus().toggleHeading({ level: 1 }).run())} title="大標題">H1</button>
        <button style={btn(h2.value)} onClick={run((ed: any) => ed.chain().focus().toggleHeading({ level: 2 }).run())} title="中標題">H2</button>
        <button style={btn(h3.value)} onClick={run((ed: any) => ed.chain().focus().toggleHeading({ level: 3 }).run())} title="小標題">H3</button>
        <span class="tip-sep" />
        <button style={btn(bold.value)} onClick={run((ed: any) => ed.chain().focus().toggleBold().run())} title="粗體"><b>B</b></button>
        <button style={btn(italic.value)} onClick={run((ed: any) => ed.chain().focus().toggleItalic().run())} title="斜體"><i>I</i></button>
        <button style={btn(strike.value)} onClick={run((ed: any) => ed.chain().focus().toggleStrike().run())} title="刪除線"><s>S</s></button>
        <span class="tip-sep" />
        <button style={btn(bullet.value)} onClick={run((ed: any) => ed.chain().focus().toggleBulletList().run())} title="項目符號">• 清單</button>
        <button style={btn(ordered.value)} onClick={run((ed: any) => ed.chain().focus().toggleOrderedList().run())} title="編號清單">1. 清單</button>
        <span class="tip-sep" />
        <button style={btn(alignLeft.value)} onClick={run((ed: any) => ed.chain().focus().setTextAlign('left').run())} title="靠左">⇤</button>
        <button style={btn(alignCenter.value)} onClick={run((ed: any) => ed.chain().focus().setTextAlign('center').run())} title="置中">⇔</button>
        <button style={btn(alignRight.value)} onClick={run((ed: any) => ed.chain().focus().setTextAlign('right').run())} title="靠右">⇥</button>
        <span class="tip-sep" />
        <button style="margin:0 2px;padding:4px 9px;font-size:12.5px;border:1px solid #d3d9e3;border-radius:6px;background:#fff;color:#333;cursor:pointer;line-height:1.4;" onClick={insertTable} title="插入表格（3×3）">⊞ 表格</button>
        <button style="margin:0 2px;padding:4px 9px;font-size:12.5px;border:1px solid #d3d9e3;border-radius:6px;background:#fff;color:#333;cursor:pointer;line-height:1.4;" onClick={addTableRow} title="表格下方加一列">＋列</button>
        <button style="margin:0 2px;padding:4px 9px;font-size:12.5px;border:1px solid #d3d9e3;border-radius:6px;background:#fff;color:#333;cursor:pointer;line-height:1.4;" onClick={addTableCol} title="表格右側加一欄">＋欄</button>
        <button style="margin:0 2px;padding:4px 9px;font-size:12.5px;border:1px solid #d3d9e3;border-radius:6px;background:#fff;color:#333;cursor:pointer;line-height:1.4;" onClick={deleteTable} title="刪除表格">✕ 表格</button>
        <span class="tip-sep" />
        <button style="margin:0 2px;padding:4px 9px;font-size:12.5px;border:1px solid #d3d9e3;border-radius:6px;background:#fff;color:#333;cursor:pointer;line-height:1.4;" onClick={insertImage} title="插入圖片（網址）">🖼 圖片</button>
      </div>
      <div class="tiptap-fields">
        <span style="font-size:12px;color:#556;margin-right:6px;">插入系統欄位：</span>
        {grouped.length > 0 && (
          <select style="max-width:120px;padding:3px 6px;border:1px solid #d3d9e3;border-radius:6px;font-size:12px;"
            value={fieldGroup.value} onChange={(e: any) => (fieldGroup.value = e.currentTarget.value)}>
            {grouped.map((g: any) => <option value={g.group}>{g.group}</option>)}
          </select>
        )}
        {(currentGroup.list || []).map((f: any) => (
          <button key={f.token} class="btn btn-sm" style="margin:2px;" onClick={() => insertField(f.token)} title={`插入「${f.label}」`}>{f.label}</button>
        ))}
        <span style="font-size:11px;color:#8a93a6;margin-left:8px;">點選後插入游標位置；列印時自動帶入實際資料。</span>
      </div>
      <div class="tiptap-host" ref={hostRef} style={{ minHeight: `${minHeight}px` }} />
    </div>
  );
}
