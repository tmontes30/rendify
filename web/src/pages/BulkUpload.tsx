import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CURRENCIES,
  CURRENCY_CODES,
  DOC_TYPES,
  DOC_TYPE_LABELS,
  LIMITS,
  formatMoney,
  fromMinor,
  toMinor,
  type Category,
  type Currency,
  type DocType,
} from '@rendiciones/shared';
import { useSession } from '../auth';
import { friendlyError, listCategories } from '../data';
import { defaultTitle, emptyRow, type RowState } from './ReportEditor';
import { useGlobalBusy } from '@rendiciones/shared/Busy';

// Formato oficial de la plantilla. Si cambias columnas, sube la versión.
const FORMAT_ID = 'RENDICIONES_PLANTILLA_V1';
const SHEET = 'Gastos';
const LISTS = 'Listas';
const HEADERS = ['Fecha', 'Categoría', 'Descripción', 'Proveedor', 'Tipo documento', 'N° documento', 'Moneda', 'Monto'] as const;
const MAX_ROWS = LIMITS.maxItems;
const MAX_BYTES = 5 * 1024 * 1024;
const EXAMPLE_PREFIX = 'EJEMPLO';

type ExcelJS = typeof import('exceljs');
const loadExcel = async (): Promise<ExcelJS> => {
  const mod = await import('exceljs');
  return ((mod as unknown as { default?: ExcelJS }).default ?? mod) as ExcelJS;
};

interface ParsedRow {
  line: number;
  row?: RowState;
  errors: string[];
  preview: { date: string; category: string; description: string; amount: string };
}

export function BulkUpload() {
  const { company } = useSession();
  const navigate = useNavigate();
  const [categories, setCategories] = useState<Category[]>([]);
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useGlobalBusy('Procesando…');
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listCategories(company.id).then((c) => setCategories(c.filter((x) => x.active)), (e) => setError(friendlyError(e)));
  }, [company.id]);

  async function downloadTemplate() {
    setBusy(true);
    setError(null);
    try {
      const Excel = await loadExcel();
      const wb = new Excel.Workbook();
      wb.creator = 'Rendify';
      wb.created = new Date();

      const ws = wb.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = [
        { header: HEADERS[0], key: 'date', width: 14, style: { numFmt: 'dd-mm-yyyy' } },
        { header: HEADERS[1], key: 'cat', width: 22 },
        { header: HEADERS[2], key: 'desc', width: 40 },
        { header: HEADERS[3], key: 'vendor', width: 24 },
        { header: HEADERS[4], key: 'doc', width: 16 },
        { header: HEADERS[5], key: 'docn', width: 16 },
        { header: HEADERS[6], key: 'cur', width: 10 },
        { header: HEADERS[7], key: 'amt', width: 14, style: { numFmt: '#,##0.##' } },
      ];
      const head = ws.getRow(1);
      head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5BD3' } };
      head.alignment = { vertical: 'middle', horizontal: 'center' };
      head.height = 26;

      // Nota (comentario) en cada encabezado explicando qué va en la columna.
      const notes = [
        'OBLIGATORIO. Fecha del gasto, formato dd-mm-aaaa. Ej: 15-10-2026',
        'OBLIGATORIO. Elige de la lista desplegable o escribe otra si no está.',
        'OBLIGATORIO. Qué se compró o pagó. Ej: Taxi al aeropuerto',
        'Opcional. Nombre o RUT del comercio.',
        'Opcional. Elige de la lista: Boleta, Factura u Otro. Si lo dejas vacío se usa Boleta.',
        'Opcional. Número de la boleta o factura.',
        `OBLIGATORIO. Elige de la lista (normalmente ${company.baseCurrency}).`,
        'OBLIGATORIO. Solo el número, sin $ ni puntos de miles. Ej: 15000 o 12,50',
      ];
      notes.forEach((n, i) => (ws.getCell(1, i + 1).note = n));

      // Fila 2: ejemplo resuelto (no se carga al subir el archivo).
      const ex = ws.getRow(2);
      const today = new Date();
      ex.values = [
        new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())),
        categories[0]?.name ?? 'Transporte',
        `${EXAMPLE_PREFIX} Taxi al aeropuerto (esta fila es de ejemplo y no se carga)`,
        'Taxi SpA',
        DOC_TYPE_LABELS.boleta,
        '123456',
        company.baseCurrency,
        CURRENCIES[company.baseCurrency].decimals ? 15000.5 : 15000,
      ];
      ex.font = { italic: true, color: { argb: 'FF7A5B00' } };
      ex.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4CC' } };
      ex.height = 20;

      // Hoja oculta con las listas para los desplegables y la marca de formato.
      const lists = wb.addWorksheet(LISTS, { state: 'veryHidden' });
      categories.forEach((c, i) => (lists.getCell(i + 1, 1).value = c.name));
      DOC_TYPES.forEach((t, i) => (lists.getCell(i + 1, 2).value = DOC_TYPE_LABELS[t]));
      CURRENCY_CODES.forEach((c, i) => (lists.getCell(i + 1, 3).value = c));
      lists.getCell('Z1').value = `${FORMAT_ID}:${company.id}`;

      // Validaciones con mensaje de ayuda al seleccionar cada celda.
      const nCat = Math.max(categories.length, 1);
      for (let r = 2; r <= MAX_ROWS + 2; r++) {
        ws.getCell(r, 1).dataValidation = {
          type: 'date', operator: 'greaterThan', allowBlank: true, formulae: [new Date(2000, 0, 1)],
          showInputMessage: true, promptTitle: 'Fecha', prompt: 'dd-mm-aaaa. Ej: 15-10-2026',
          showErrorMessage: true, errorTitle: 'Fecha', error: 'Ingresa una fecha válida (dd-mm-aaaa).',
        };
        ws.getCell(r, 2).dataValidation = {
          type: 'list', allowBlank: true, formulae: [`${LISTS}!$A$1:$A$${nCat}`],
          showInputMessage: true, promptTitle: 'Categoría', prompt: 'Elige de la lista o escribe otra si no está.',
          showErrorMessage: false,
        };
        ws.getCell(r, 3).dataValidation = {
          type: 'textLength', operator: 'lessThanOrEqual', allowBlank: true, formulae: [500],
          showInputMessage: true, promptTitle: 'Descripción', prompt: 'Qué se compró o pagó. Ej: Almuerzo con cliente',
        };
        ws.getCell(r, 5).dataValidation = {
          type: 'list', allowBlank: true, formulae: [`${LISTS}!$B$1:$B$${DOC_TYPES.length}`],
          showInputMessage: true, promptTitle: 'Tipo de documento', prompt: 'Boleta, Factura u Otro.',
          showErrorMessage: true, error: 'Elige un tipo de documento de la lista.',
        };
        ws.getCell(r, 7).dataValidation = {
          type: 'list', allowBlank: true, formulae: [`${LISTS}!$C$1:$C$${CURRENCY_CODES.length}`],
          showInputMessage: true, promptTitle: 'Moneda', prompt: `Normalmente ${company.baseCurrency}.`,
          showErrorMessage: true, error: 'Elige una moneda de la lista.',
        };
        ws.getCell(r, 8).dataValidation = {
          type: 'decimal', operator: 'greaterThan', allowBlank: true, formulae: [0],
          showInputMessage: true, promptTitle: 'Monto', prompt: 'Solo el número. Ej: 15000',
          showErrorMessage: true, error: 'El monto debe ser un número mayor que 0.',
        };
      }

      const help = wb.addWorksheet('Instrucciones');
      help.getColumn(1).width = 110;
      [
        'Cómo usar esta plantilla',
        '',
        `1. Ve a la hoja "${SHEET}". La fila 2 (amarilla) es un EJEMPLO: muestra cómo llenar cada columna. Puedes dejarla tal cual o borrarla; no se carga.`,
        `2. Escribe tus gastos desde la fila 3 hacia abajo: una fila por cada gasto (máximo ${MAX_ROWS}).`,
        '3. Obligatorios: Fecha, Categoría, Descripción, Moneda y Monto. Opcionales: Proveedor, Tipo documento y N° documento.',
        '4. Tipo documento y Moneda se eligen desde la lista desplegable. En Categoría puedes elegir de la lista o escribir otra si no está.',
        '5. Fecha en formato dd-mm-aaaa (ej: 15-10-2026). Monto solo el número, sin $ ni puntos de miles (ej: 15000 o 12,50).',
        '6. Pasa el mouse sobre los títulos de las columnas para ver una ayuda de cada una.',
        '7. No cambies los títulos de las columnas ni el nombre de las hojas.',
        '8. Guarda el archivo como .xlsx y súbelo en la página "Carga masiva". Antes de enviar podrás revisar todo y adjuntar fotos de respaldo.',
        '',
        `Plantilla generada para ${company.name}. Si cambian las categorías, descarga una plantilla nueva.`,
      ].forEach((t, i) => {
        const c = help.getCell(i + 1, 1);
        c.value = t;
        c.alignment = { wrapText: true, vertical: 'top' };
        if (i === 0) c.font = { bold: true, size: 14 };
      });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `plantilla-rendicion-${company.id}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('No se pudo generar la plantilla. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File) {
    setError(null);
    setParsed(null);
    setFileName(file.name);
    if (!/\.xlsx$/i.test(file.name)) return setError('Solo se acepta la plantilla en formato Excel (.xlsx). Descárgala con el botón de arriba.');
    if (file.size > MAX_BYTES) return setError('El archivo es demasiado grande (máximo 5 MB).');
    setBusy(true);
    try {
      const Excel = await loadExcel();
      const wb = new Excel.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const ws = wb.getWorksheet(SHEET);
      const lists = wb.getWorksheet(LISTS);
      const marker = lists ? text(lists.getCell('Z1').value) : '';
      if (!ws || !marker.startsWith(FORMAT_ID)) {
        return setError('Este archivo no es la plantilla oficial. Descarga la plantilla, completa tus gastos en ella y súbela.');
      }
      if (marker !== `${FORMAT_ID}:${company.id}`) {
        return setError('Esta plantilla es de otra empresa. Descarga la plantilla desde tu cuenta.');
      }
      const head = HEADERS.map((_, i) => text(ws.getCell(1, i + 1).value));
      if (head.some((h, i) => h !== HEADERS[i])) {
        return setError('Las columnas de la plantilla fueron modificadas. Descarga una plantilla nueva y no cambies los títulos.');
      }

      const out: ParsedRow[] = [];
      for (let r = 2; r <= ws.rowCount; r++) {
        const cells = HEADERS.map((_, i) => ws.getCell(r, i + 1).value);
        if (cells.every((v) => text(v) === '')) continue;
        if (text(cells[2]).toUpperCase().startsWith(EXAMPLE_PREFIX)) continue; // fila de ejemplo
        if (out.length >= MAX_ROWS) {
          setError(`La plantilla tiene más de ${MAX_ROWS} gastos. Divídelos en dos rendiciones.`);
          break;
        }
        out.push(parseRow(r, cells, categories));
      }
      if (!out.length) return setError('La plantilla no tiene gastos. Completa al menos una fila en la hoja "Gastos".');
      setParsed(out);
    } catch {
      setError('No se pudo leer el archivo. Asegúrate de que sea la plantilla .xlsx sin modificar su estructura.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const ok = parsed?.filter((p) => p.row) ?? [];
  const bad = parsed?.filter((p) => !p.row) ?? [];

  function proceed() {
    navigate('/nueva', { state: { rows: ok.map((p) => p.row!), title: `${defaultTitle()} (carga masiva)` } });
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) void handleFile(f);
  };

  return (
    <div className="stack">
      <Link to="/mis-rendiciones" className="back-link">← Mis rendiciones</Link>
      <div className="page-header">
        <div>
          <h1>Carga masiva</h1>
          <p className="muted page-sub">Sube todos tus gastos de una vez con la plantilla Excel.</p>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card step-card">
          <div className="step-num">1</div>
          <h3>Descarga la plantilla</h3>
          <p className="muted small">Trae listas desplegables con las categorías de {company.name}, tipos de documento y monedas.</p>
          <button className="primary" onClick={downloadTemplate} disabled={busy || !categories.length}>⇩ Descargar plantilla .xlsx</button>
          {!categories.length && <div className="hint">Tu empresa aún no tiene categorías de gasto.</div>}
        </div>
        <div className="card step-card">
          <div className="step-num">2</div>
          <h3>Súbela completa</h3>
          <div
            className={`dropzone${drag ? ' drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            onClick={() => input.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
          >
            <div className="dz-icon" aria-hidden="true">⇪</div>
            <div><b>Arrastra tu archivo aquí</b> o haz clic para elegirlo</div>
            <div className="muted small">Solo la plantilla oficial (.xlsx)</div>
            {fileName && <div className="small" style={{ marginTop: 6 }}>📄 {fileName}</div>}
          </div>
          <input
            ref={input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])}
          />
        </div>
      </div>

      {busy && <p className="muted">Procesando…</p>}
      {error && <div className="alert error">{error}</div>}

      {parsed && (
        <div className="card">
          <div className="row spread">
            <h2 style={{ margin: 0 }}>Revisión del archivo</h2>
            <div className="row small">
              <span className="badge approved">{ok.length} correctos</span>
              {bad.length > 0 && <span className="badge rejected">{bad.length} con errores</span>}
            </div>
          </div>
          {bad.length > 0 && (
            <div className="alert warn" style={{ marginTop: 12 }}>
              Corrige las filas con errores en el Excel y vuelve a subirlo, o continúa solo con los gastos correctos.
            </div>
          )}
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Fila</th>
                  <th>Fecha</th>
                  <th>Categoría</th>
                  <th>Descripción</th>
                  <th className="num">Monto</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((p) => (
                  <tr key={p.line} className={p.row ? '' : 'row-bad'}>
                    <td className="small">{p.line}</td>
                    <td className="small">{p.preview.date}</td>
                    <td>{p.preview.category}</td>
                    <td>{p.preview.description}</td>
                    <td className="num">{p.preview.amount}</td>
                    <td className="small">{p.row ? '✓' : <span className="text-bad">{p.errors.join(' · ')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="primary" disabled={!ok.length} onClick={proceed}>
              Continuar con {ok.length} gasto(s) →
            </button>
          </div>
          <p className="hint" style={{ textAlign: 'right' }}>En el siguiente paso revisas, confirmas y envías a aprobación.</p>
        </div>
      )}
    </div>
  );
}

/** Texto plano de una celda de exceljs (texto, número, fecha, texto enriquecido o fórmula). */
function text(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string };
    if (o.richText) return o.richText.map((t) => t.text).join('').trim();
    if ('result' in o) return text(o.result);
    if (o.text) return String(o.text).trim();
    return '';
  }
  return String(v).trim();
}

function toIsoDate(v: unknown): string | null {
  const pad = (n: number) => String(n).padStart(2, '0');
  if (v && typeof v === 'object' && 'result' in (v as object)) v = (v as { result: unknown }).result;
  if (v instanceof Date && !isNaN(v.getTime())) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400000)); // número de serie de Excel
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = text(v);
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function parseRow(line: number, cells: unknown[], categories: Category[]): ParsedRow {
  const [vDate, vCat, vDesc, vVendor, vDoc, vDocN, vCur, vAmt] = cells;
  const errors: string[] = [];
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  const date = toIsoDate(vDate);
  if (!date) errors.push('Fecha inválida');
  else if (date > new Date().toISOString().slice(0, 10)) errors.push('Fecha futura');

  const catText = text(vCat);
  const cat = categories.find((c) => norm(c.name) === norm(catText));
  // Si no está en la lista, se acepta como categoría escrita por el usuario.
  if (!catText) errors.push('Falta categoría');

  const description = text(vDesc);
  if (!description) errors.push('Falta descripción');

  const docText = text(vDoc);
  const docType = (DOC_TYPES.find((t) => norm(DOC_TYPE_LABELS[t]) === norm(docText) || t === norm(docText)) ?? (docText ? null : 'boleta')) as DocType | null;
  if (!docType) errors.push('Tipo de documento inválido');

  const curText = text(vCur).toUpperCase();
  const currency = (CURRENCY_CODES as string[]).includes(curText) ? (curText as Currency) : null;
  if (!currency) errors.push(curText ? `Moneda "${curText}" inválida` : 'Falta moneda');

  let amount: number | null = null;
  if (currency) {
    const raw = v(vAmt);
    if (typeof raw === 'number') {
      const d = CURRENCIES[currency].decimals;
      const m = Math.round(raw * 10 ** d);
      amount = raw > 0 && Number.isSafeInteger(m) ? m : null;
    } else {
      amount = toMinor(text(raw), currency);
    }
    if (amount == null) errors.push('Monto inválido');
  }

  const preview = {
    date: date ?? text(vDate),
    category: cat?.name ?? (catText ? `${catText} (nueva)` : ''),
    description,
    amount: amount != null && currency ? formatMoney(amount, currency) : text(vAmt),
  };
  if (errors.length) return { line, errors, preview };

  const row: RowState = {
    ...emptyRow(currency!, cat ? cat.id : 'custom'),
    customCategory: cat ? '' : catText.slice(0, 60),
    date: date!,
    description: description.slice(0, LIMITS.description),
    vendor: text(vVendor).slice(0, LIMITS.vendor),
    docType: docType!,
    docNumber: text(vDocN).slice(0, LIMITS.docNumber),
    amountText: fromMinor(amount!, currency!),
  };
  return { line, row, errors, preview };

  function v(x: unknown) {
    return x && typeof x === 'object' && 'result' in (x as object) ? (x as { result: unknown }).result : x;
  }
}
