import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { Alert, Platform } from 'react-native';
import { DoctorProfile, formatDoctorHeader, formatCRM } from './doctor';

interface PDFInput {
  name: string;
  createdAt: string;
  transcript: string | null;
  summary: string | null;
  templateName: string | null;
  isMindmap?: boolean;
  doctor?: DoctorProfile;
}

const MONTHS_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatLongDate(d: Date): string {
  return `${d.getDate()} de ${MONTHS_PT[d.getMonth()]} de ${d.getFullYear()}`;
}

function formatDateDDMMYYYY(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Strip ALL leading lines that are just Rx/R/℞ or "Uso oral" variants.
 * We render Rx + Uso oral as styled markup separately above the body.
 * Line-by-line approach handles repeated patterns like:
 *   "Rx Uso oral\nR Uso oral\n. Uso oral\n1. Clavulin..."
 * — all three leading lines get stripped, only "1. Clavulin..." remains.
 */
function stripRxPrefix(body: string): string {
  const usageRoutes = '(oral|tópico|topico|sublingual|inalatório|inalatorio|intramuscular|endovenoso|nasal|retal)';
  // Matches lines that should be stripped:
  //   "Rx" / "R" / "℞"  (alone)
  //   "Rx Uso oral" / "R Uso oral" / "℞ Uso oral"
  //   "Uso oral"  (alone)
  //   ". Uso oral" / "- Uso oral" / "• Uso oral"  (bullet variants)
  const stripPattern = new RegExp(
    `^\\s*(?:[.\\-•*][ \\t]*)?(?:(?:℞|Rx|R)(?:[ \\t]+Uso\\s+${usageRoutes})?|Uso\\s+${usageRoutes})\\s*$`,
    'i'
  );

  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || stripPattern.test(line)) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n').trimStart();
}

function getMedicalDocumentTitle(t: string | null): string | null {
  if (!t) return null;
  const u = t.toUpperCase();
  if (u.includes('ATESTADO')) return 'Atestado Médico';
  if (u.includes('SOLICITAÇÃO') || u.includes('EXAMES')) return 'Solicitação de Exames';
  if (u.includes('ENCAMINHAMENTO')) return 'Encaminhamento Médico';
  if (u.includes('RECEITUÁRIO') || u.includes('RECEITA')) return 'Receituário Médico';
  return null;
}

// Controlled substance names covered by Portaria SVS/MS 344/98 and RDC 20/2011.
// Detection is case-insensitive and covers both brand names and active ingredients.
// This list acts as a LOCAL FALLBACK when the AI doesn't emit [C1]-[C5] markers.
const CONTROLLED_SUBSTANCE_PATTERN = new RegExp(
  [
    // Benzodiazepínicos (C1)
    'clonazepam', 'rivotril',
    'diazepam', 'valium',
    'alprazolam', 'frontal',
    'bromazepam', 'lexotan',
    'lorazepam', 'lorax',
    'zolpidem', 'stilnox',
    'nitrazepam',
    'midazolam', 'dormicum',
    'clobazam', 'frisium',
    'flunitrazepam', 'rohypnol',
    'cloxazolam', 'olcadil',
    'flurazepam', 'dalmane',
    // Psicoestimulantes anfetamínicos (A3 / C3)
    'metilfenidato', 'ritalina', 'concerta', 'ritalin', 'ritalin la',
    'lisdexanfetamina', 'vyvanse',
    'anfetamina',
    // Opioides (RDC 20)
    'tramadol', 'tramal',
    'codeína', 'codeina',
    'buprenorfina',
    'metadona',
    'morfina', 'mst continus', 'dimorf',
    'fentanil', 'durogesic', 'fentanest',
    'oxicodona', 'oxycontin',
    'hidrocodona',
    'tapentadol', 'palexia',
    'meperidina', 'petidina',
    // Lista C5
    'talidomida', 'talidomide',
    // Canabinoides (C1/RDC)
    'canabidiol', 'cannabidiol', '\\bcbd\\b',
    'dronabinol',
  ].join('|'),
  'i'
);

function hasControlledMeds(body: string): boolean {
  // Primary: AI emitted explicit classification markers
  if (/\[(C[1-5]|RDC\s*20)\]/i.test(body)) return true;
  // Fallback: detect controlled substance names in the text
  return CONTROLLED_SUBSTANCE_PATTERN.test(body);
}

function stripAllMarkers(body: string): string {
  return body.replace(/\s*\[(C[1-5]|RDC\s*20|SIMPLES)\]/g, '');
}

function stripPrescriptionExtras(body: string): string {
  let cleaned = body;
  cleaned = cleaned.replace(/^Receita Médica\s*\n+/i, '');
  cleaned = cleaned.replace(/^Receituário[^\n]*\n+/i, '');
  cleaned = cleaned.replace(/^Data:[^\n]*\n/m, '');
  cleaned = cleaned.replace(/\n[ \t]*_{10,}[ \t]*\n[\s\S]*$/, '');
  return cleaned.trim();
}

function extractPatientName(body: string): string {
  const m = body.match(/^Paciente:\s*(.+)$/m);
  return m ? m[1].trim() : 'Não informado';
}

function stripPatientLine(body: string): string {
  return body.replace(/^Paciente:[^\n]*\n+/m, '').trim();
}

// ─── CADUCEUS SVG (inline, reutilizado no cabeçalho e marca d'água) ──────────

const CADUCEUS_PATHS = `
  <line x1="60" y1="10" x2="60" y2="190" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>
  <circle cx="60" cy="13" r="12" stroke="currentColor" stroke-width="4" fill="none"/>
  <path d="M60 33 C38 20 16 34 18 52 C20 64 47 58 60 48"
        stroke="currentColor" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M60 33 C82 20 104 34 102 52 C100 64 73 58 60 48"
        stroke="currentColor" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M60 48 C37 57 43 76 60 83 C77 90 83 109 60 117 C37 125 43 144 60 152 C77 160 71 176 60 186"
        stroke="currentColor" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  <path d="M60 48 C83 57 77 76 60 83 C43 90 37 109 60 117 C83 125 77 144 60 152 C43 160 49 176 60 186"
        stroke="currentColor" stroke-width="4.5" fill="none" stroke-linecap="round"/>
`;

/** Formata o CRM no padrão visual do cabeçalho: "CRM/CE  ·  17946" */
function formatCRMHeader(doctor: DoctorProfile | undefined): string {
  if (!doctor?.crmNumber) return '';
  const uf = doctor.crmUF ? `/${doctor.crmUF}` : '';
  return `CRM${uf}  ·  ${doctor.crmNumber}`;
}

// ─── BRANDED PRESCRIPTION (design "Receituário.html") ────────────────────────
//
// Implementa o template visual aprovado pelo Dr. Rafael Brauner:
//   • Header: gradiente azul L→R + nome em serif + caduceu
//   • Regra fina azul separando header do corpo
//   • Corpo: campos Nome/Data, símbolo ℞, conteúdo da prescrição
//   • Assinatura: canto inferior esquerdo, caixa com borda verde
//   • Footer: mesmo gradiente, ícone endereço + separador + ícone telefone
//   • Marca d'água: caduceu minimalista, opacidade 4,2%

function buildBrandedPrescriptionHTML(input: PDFInput): string {
  const doctor = input.doctor;
  const todayLong  = formatLongDate(new Date());
  const todayShort = formatDateDDMMYYYY(new Date().toISOString());
  const city       = doctor?.city ?? '';
  const locationDate = city ? `${city}, ${todayLong}` : todayLong;
  const recordingDate = formatDateDDMMYYYY(input.createdAt) || todayShort;

  let body = stripPrescriptionExtras(input.summary ?? '');
  const patientName = extractPatientName(body);
  body = stripAllMarkers(stripPatientLine(body));
  body = stripRxPrefix(body);

  // Use real data; fall back to visible blank placeholders so the PDF
  // still looks like a proper prescription form even without a profile.
  const drName   = doctor?.name?.trim()    || '';
  const drCRM    = formatCRMHeader(doctor) || '';
  const drTitle  = doctor?.title?.trim()   || '';
  const drAddr   = doctor?.address?.trim() || '';
  const drPhone  = doctor?.phone?.trim()   || '';

  // Flag: profile not configured (both name and CRM are empty)
  const profileEmpty = !drName && !drCRM;

  const locationIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="rgba(255,255,255,0.80)"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`;
  const phoneIcon    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="rgba(255,255,255,0.80)"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>`;

  return `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="UTF-8"/>
<style>
  @page { size: A4 portrait; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html, body { width: 210mm; min-height: 297mm; background: #fdfdff; }

  /* ── MARCA D'ÁGUA ── */
  .wm {
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    display: flex; align-items: center; justify-content: center;
  }
  .wm svg { width: 300px; height: 300px; opacity: 0.042; color: #1565a8; }

  /* ── CABEÇALHO ── */
  .hd {
    position: relative; z-index: 1;
    background: linear-gradient(to right, #0c4a8a, #1976c8, #48b0e8);
    padding: 28px 48px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 20px;
  }
  .dr-name {
    font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif;
    font-size: 28px; color: #fff; line-height: 1.18;
    text-shadow: 0 1px 12px rgba(0,0,0,0.14); letter-spacing: 0.3px;
    font-weight: 400;
  }
  .dr-subtitle {
    margin-top: 5px;
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 10px; color: rgba(255,255,255,0.80);
    letter-spacing: 2.8px; text-transform: uppercase;
  }
  .hd-icon { flex-shrink: 0; opacity: 0.84; }

  /* ── REGRA ── */
  .rule {
    position: relative; z-index: 1; height: 3px;
    background: linear-gradient(to right,rgba(12,74,138,.22),rgba(25,118,200,.5),rgba(72,176,232,.22));
  }

  /* ── CORPO ── */
  .bd {
    position: relative; z-index: 1;
    padding: 28px 48px 20px;
    display: flex; flex-direction: column;
    min-height: 195mm;
  }

  /* Campos do paciente */
  .pat {
    padding-bottom: 16px;
    border-bottom: 2.5px double #c8d8ea;
    border-radius: 0 0 4px 4px;
    margin-bottom: 20px;
    font-family: Georgia, 'Times New Roman', serif;
  }
  .pat-label {
    font-family: Georgia, serif; font-size: 12.5px; color: #5a6878;
    display: block; margin-bottom: 9px; letter-spacing: 0.2px;
  }

  /* Símbolo ℞ */
  .rx-sym {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 46px; color: #1565a8; font-weight: 300;
    line-height: 1; margin-bottom: 14px; letter-spacing: -1px;
  }

  /* Conteúdo da prescrição */
  .rx-body {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 12px; line-height: 1.75; color: #1f2937;
    white-space: pre-wrap;
    border-bottom: 2px solid #e1e9f2;
    padding-bottom: 14px;
    flex: 1;
    min-height: 120px;
  }

  /* Assinatura — canto inferior esquerdo */
  .sig-wrap { display: flex; justify-content: flex-start; padding-top: 24px; }
  .sig-blk { width: 240px; text-align: center; }
  .sig-ln { border-bottom: 1.5px solid #3a3a48; height: 48px; margin-bottom: 8px; }
  .sig-box {
    border: 1.5px solid #059669; padding: 7px 12px;
    font-family: Georgia, serif; font-size: 8px;
    letter-spacing: 1.6px; text-transform: uppercase;
    color: #2d3a4a; line-height: 1.7; text-align: center;
  }

  /* ── RODAPÉ ── */
  .ft {
    position: relative; z-index: 1;
    background: linear-gradient(to right, #0c4a8a, #1976c8, #48b0e8);
    padding: 12px 48px;
  }
  .ft-in {
    display: flex; align-items: center; justify-content: space-evenly;
  }
  .ft-item { display: flex; align-items: center; gap: 9px; color: rgba(255,255,255,0.93); }
  .ft-txt {
    font-family: Georgia, serif; font-size: 11px; letter-spacing: 0.1px;
  }
  .ft-sep { width: 1px; height: 24px; background: rgba(255,255,255,0.28); margin: 0 16px; flex-shrink: 0; }

  .date-line {
    text-align: right; font-family: Georgia, serif;
    font-size: 11px; color: #5a6878; margin-top: 8px; padding-right: 4px;
  }

  @media print {
    .wm { position: fixed; }
    html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
<!-- Cormorant Garamond como fallback elegante para Amsterdam Four -->
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;600&display=swap" rel="stylesheet"/>
</head>
<body>

<!-- MARCA D'ÁGUA -->
<div class="wm">
  <svg viewBox="0 0 120 200" fill="none" xmlns="http://www.w3.org/2000/svg">
    ${CADUCEUS_PATHS}
  </svg>
</div>

<!-- CABEÇALHO -->
<header class="hd">
  <div>
    <div class="dr-name">${drName ? escapeHTML(drName) : '<span style="color:rgba(255,255,255,0.38);font-style:italic;font-size:20px">Nome do médico</span>'}</div>
    ${drTitle ? `<div class="dr-subtitle">${escapeHTML(drTitle)}</div>` : ''}
    ${drCRM
      ? `<div class="dr-subtitle" style="margin-top:${drTitle ? '2px' : '5px'}">${escapeHTML(drCRM)}</div>`
      : `<div class="dr-subtitle" style="margin-top:${drTitle ? '2px' : '5px'};color:rgba(255,255,255,0.32);font-style:italic">CRM/UF · Número</div>`}
  </div>
  <div class="hd-icon">
    <svg width="42" height="70" viewBox="0 0 120 200" fill="none">
      ${CADUCEUS_PATHS.replace(/currentColor/g, 'white')}
    </svg>
  </div>
</header>

<!-- REGRA -->
<div class="rule"></div>

<!-- CORPO -->
<main class="bd">

  <!-- Campos do paciente -->
  <div class="pat">
    <span class="pat-label">Nome: ${escapeHTML(patientName)}</span>
    <span class="pat-label">Data: ${escapeHTML(recordingDate)}</span>
  </div>

  <!-- ℞ -->
  <div class="rx-sym">&#8478;</div>

  <!-- Prescrição -->
  <div class="rx-body">${escapeHTML(body)}</div>

  <!-- Assinatura -->
  <div class="sig-wrap">
    <div class="sig-blk">
      <div class="sig-ln"></div>
      <div class="sig-box">
        ${drName ? escapeHTML(drName) : '________________________________'}
        ${drCRM  ? `<br>${escapeHTML(drCRM.replace('  ·  ', ' '))}` : '<br>CRM/UF · N°'}
      </div>
    </div>
  </div>

  <!-- Data e local -->
  <div class="date-line">${escapeHTML(locationDate)}</div>

</main>

<!-- RODAPÉ -->
<footer class="ft">
  <div class="ft-in">
    ${profileEmpty
      ? `<div class="ft-item"><span class="ft-txt" style="color:rgba(255,255,255,0.42);font-style:italic;font-size:10px">Configure em Ajustes → Perfil Profissional</span></div>`
      : `
        ${(drAddr || city)
          ? `<div class="ft-item">${locationIcon}<span class="ft-txt">${escapeHTML(drAddr)}${(drAddr && city) ? ` · ${escapeHTML(city)}` : escapeHTML(city)}</span></div>`
          : ''}
        ${(drAddr || city) && drPhone ? '<div class="ft-sep"></div>' : ''}
        ${drPhone ? `<div class="ft-item">${phoneIcon}<span class="ft-txt">${escapeHTML(drPhone)}</span></div>` : ''}
      `
    }
  </div>
</footer>

</body></html>`;
}

// ─── OTHER MEDICAL DOCUMENTS (non-prescription) ──────────────────────────────

function buildMedicalDocumentHTML(input: PDFInput, title: string): string {
  const doctor = input.doctor;
  const headerLine = doctor ? formatDoctorHeader(doctor) : '';
  const todayLong = formatLongDate(new Date());
  const city = doctor?.city ?? '';
  const locationDate = city ? `${city}, ${todayLong}` : todayLong;

  const body = stripAllMarkers(stripPrescriptionExtras(input.summary ?? ''));

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  @page { size: A4; margin: 16mm 18mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; color: #111827; line-height: 1.5; }
  header { text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { color: #2563eb; font-size: 26px; margin: 0; font-weight: 800; letter-spacing: 0.3px; }
  .doctor-header { color: #6b7280; font-size: 12px; margin-top: 6px; }
  main { font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; color: #1f2937; }
  footer { margin-top: 48px; }
  .signature { text-align: center; margin-bottom: 20px; }
  .signature .line { width: 60%; margin: 0 auto 6px auto; border-top: 1px solid #111827; }
  .signature .name { font-size: 12.5px; font-weight: 700; color: #111827; }
  .signature .title, .signature .reg { font-size: 11.5px; color: #4b5563; margin-top: 2px; }
  .location-date { text-align: right; font-size: 11.5px; color: #4b5563; }
</style></head><body>
  <header>
    <h1>${escapeHTML(title)}</h1>
    ${headerLine ? `<div class="doctor-header">${escapeHTML(headerLine)}</div>` : ''}
  </header>
  <main>${escapeHTML(body)}</main>
  <footer>
    <div class="signature">
      <div class="line"></div>
      ${doctor?.name ? `<div class="name">${escapeHTML(doctor.name)}</div>` : ''}
      ${doctor?.title ? `<div class="title">${escapeHTML(doctor.title)}</div>` : ''}
      ${doctor ? `<div class="reg">${escapeHTML(formatCRM(doctor))}</div>` : ''}
    </div>
    <div class="location-date">${escapeHTML(locationDate)}</div>
  </footer>
</body></html>`;
}

// ─── SPECIAL CONTROLLED PRESCRIPTION (2 vias) ─────────────────

function buildSpecialPrescriptionHTML(input: PDFInput): string {
  const doctor = input.doctor;
  const todayLong = formatLongDate(new Date());
  const city = doctor?.city ?? '';
  const locationDate = city ? `${city}, ${todayLong}` : todayLong;
  const recordingDate = formatDateDDMMYYYY(input.createdAt);

  let body = stripPrescriptionExtras(input.summary ?? '');
  const patient = extractPatientName(body);
  body = stripAllMarkers(stripPatientLine(body));
  body = stripRxPrefix(body);

  const renderVia = (viaLabel: string) => `
    <section class="via">
      <h1>RECEITUÁRIO CONTROLE ESPECIAL</h1>
      <div class="top">
        <div class="emitente">
          <div class="box-title">IDENTIFICAÇÃO DO EMITENTE</div>
          <div class="field"><span class="label">Nome Completo:</span> ${escapeHTML(doctor?.name ?? '')}</div>
          <div class="field"><span class="label">${escapeHTML(formatCRM(doctor ?? {} as DoctorProfile))}</span></div>
          <div class="field"><span class="label">Endereço:</span> ${escapeHTML(doctor?.address ?? '')}</div>
          <div class="field"><span class="label">Telefone:</span> ${escapeHTML(doctor?.phone ?? '')}</div>
          <div class="field"><span class="label">Cidade:</span> ${escapeHTML(doctor?.city ?? '')}${doctor?.crmUF ? ' - ' + escapeHTML(doctor.crmUF) : ''}</div>
        </div>

        <div class="via-info">
          <div class="via-label">${viaLabel}</div>
          <div class="via-spacer"></div>
          <div class="signature-in-header">
            <div class="sig-line"></div>
            ${doctor?.name ? `<div class="sig-name">${escapeHTML(doctor.name)}</div>` : ''}
            ${doctor?.title ? `<div class="sig-title">${escapeHTML(doctor.title)}</div>` : ''}
            ${doctor ? `<div class="sig-reg">${escapeHTML(formatCRM(doctor))}</div>` : ''}
          </div>
        </div>
      </div>

      <div class="paciente-section">
        <div class="field paciente-line"><span class="label">Paciente:</span> ${escapeHTML(patient)}</div>
        <div class="field paciente-line"><span class="label">Data:</span> ${escapeHTML(recordingDate)}</div>
        <div class="field paciente-line"><span class="label">Endereço:</span> ____________________________________________________</div>
      </div>

      <div class="prescription-block">
        <div class="prescription-label">Prescrição:</div>
        <div class="rx-header">
          <div class="rx-symbol">℞</div>
          <div class="rx-usage">Uso oral</div>
        </div>
        <pre class="prescription">${escapeHTML(body)}</pre>
      </div>

      <div class="bottom">
        <div class="box">
          <div class="box-title">IDENTIFICAÇÃO DO COMPRADOR</div>
          <div class="line-field"><span class="label">Nome:</span> _______________________________</div>
          <div class="line-field"><span class="label">Ident.:</span> _____________ <span class="label">Órg. Emissor:</span> ________</div>
          <div class="line-field"><span class="label">End.:</span> _______________________________</div>
          <div class="line-field"><span class="label">Cidade:</span> __________________ <span class="label">UF:</span> ___</div>
          <div class="line-field"><span class="label">Telefone:</span> ____________________</div>
        </div>
        <div class="box">
          <div class="box-title">IDENTIFICAÇÃO DO FORNECEDOR</div>
          <div class="space"></div>
          <div class="assinatura-farm">
            <div class="line"></div>
            ASSINATURA DO FARMACÊUTICO &nbsp; DATA: ___ / ___ / ___
          </div>
        </div>
      </div>

      <div class="footer-date-only">${escapeHTML(locationDate)}</div>
    </section>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  @page { size: A4 portrait; margin: 12mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #000; font-size: 10.5px; line-height: 1.4; }
  .via { page-break-after: always; padding: 0; }
  .via:last-child { page-break-after: auto; }
  h1 { text-align: center; font-size: 13px; font-weight: bold; margin: 0 0 12px 0; letter-spacing: 0.5px; }

  /* Cabeçalho: emitente (esquerda) + via-info+assinatura (direita), bordas alinhadas */
  .top {
    display: flex;
    align-items: stretch;
    gap: 10px;
    margin-bottom: 14px;
  }
  .emitente {
    flex: 1.8;
    border: 1px solid #000;
    padding: 6px 8px;
    box-sizing: border-box;
  }
  .box-title {
    text-align: center;
    font-weight: bold;
    font-size: 10.5px;
    border-bottom: 1px solid #000;
    padding-bottom: 3px;
    margin-bottom: 6px;
  }
  .emitente .field {
    font-size: 10px;
    margin: 3px 0;
    padding-bottom: 2px;
    border-bottom: 1px dotted #999;
  }
  .emitente .field .label { font-weight: bold; }

  .via-info {
    flex: 1;
    border: 1px solid #000;
    padding: 6px 8px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  .via-label {
    text-align: right;
    font-weight: bold;
    font-size: 11px;
    /* stays in normal flow at the top of the column */
  }
  .via-spacer {
    flex: 1; /* pushes signature block to the bottom */
  }
  .signature-in-header {
    text-align: center;
    padding-bottom: 2px;
    width: 100%;
  }
  .signature-in-header .sig-line {
    border-top: 1px solid #000;
    margin-bottom: 4px;
    width: 95%;
    margin-left: auto;
    margin-right: auto;
  }
  .signature-in-header .sig-name {
    font-size: 10.5px;
    font-weight: bold;
  }
  .signature-in-header .sig-title,
  .signature-in-header .sig-reg {
    font-size: 9.5px;
    color: #333;
    margin-top: 1px;
  }

  .paciente-section { margin: 12px 0 8px 0; }
  .paciente-line { font-size: 11px; margin: 6px 0; }
  .paciente-line .label { font-weight: bold; }

  .prescription-block { margin: 6px 0 12px 0; }
  .prescription-label { font-weight: bold; font-size: 11px; margin-bottom: 4px; }
  .rx-header { text-align: left; margin: 6px 0 4px 0; }
  .rx-symbol {
    font-family: 'Times New Roman', Georgia, serif;
    font-size: 20px;
    font-weight: bold;
    line-height: 1.1;
    color: #000;
    margin-bottom: 1px;
  }
  .rx-usage {
    font-size: 10.5px;
    font-weight: 600;
    color: #000;
    margin-top: 1px;
  }
  .prescription {
    white-space: pre-wrap;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 10.5px;
    line-height: 1.55;
    min-height: 180px;
    margin: 0;
    padding: 6px 0;
    border-bottom: 1px solid #000;
  }

  .bottom { display: flex; gap: 10px; margin-top: 10px; }
  .box { flex: 1; border: 1px solid #000; padding: 6px 8px; min-height: 110px; position: relative; box-sizing: border-box; }
  .box .line-field { font-size: 9.5px; margin: 4px 0; }
  .box .label { font-weight: bold; }
  .space { height: 70px; }
  .assinatura-farm { position: absolute; bottom: 6px; left: 8px; right: 8px; font-size: 8.5px; text-align: center; }
  .assinatura-farm .line { border-top: 1px solid #000; margin-bottom: 2px; }

  .footer-date-only {
    text-align: right;
    font-size: 10px;
    color: #333;
    margin-top: 14px;
  }
</style></head><body>
  ${renderVia('1ª VIA FARMÁCIA')}
  ${renderVia('2ª VIA PACIENTE')}
</body></html>`;
}

// ─── GENERIC PDF ────────────────────────────────────────────

function buildGenericHTML(input: PDFInput): string {
  const doctor = input.doctor;
  const todayLong = formatLongDate(new Date());
  const city = doctor?.city ?? '';
  const locationDate = city ? `${city}, ${todayLong}` : todayLong;

  // Detect if summary already starts with a title heading (e.g. "CONSULTA MÉDICA")
  // — when it does, we skip the duplicate H2 to avoid redundancy.
  const summary = input.summary ?? '';
  const firstLine = summary.split('\n')[0]?.trim() ?? '';
  const summaryStartsWithTitle = firstLine.length > 0 && firstLine === firstLine.toUpperCase() && firstLine.length < 60;
  const templateName = input.templateName ?? 'Resumo';

  let summaryHTML = '';
  if (summary) {
    if (input.isMindmap) {
      const escapedCode = escapeHTML(summary);
      summaryHTML = `
        <section>
          <h2 class="purple">${escapeHTML(templateName)}</h2>
          <div class="mermaid-container"><pre class="mermaid">${escapedCode}</pre></div>
        </section>
        <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
        <script>mermaid.initialize({ startOnLoad: true, theme: 'default' });</script>`;
    } else if (summaryStartsWithTitle) {
      // Summary already contains its own title — render it as the document title
      const bodyWithoutTitle = summary.substring(firstLine.length).trim();
      summaryHTML = `
        <section class="main-section">
          <h1 class="doc-title">${escapeHTML(firstLine)}</h1>
          <div class="text">${escapeHTML(bodyWithoutTitle)}</div>
        </section>`;
    } else {
      summaryHTML = `
        <section class="main-section">
          <h2 class="purple">${escapeHTML(templateName)}</h2>
          <div class="text">${escapeHTML(summary)}</div>
        </section>`;
    }
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #111827; line-height: 1.5; padding: 0; margin: 0; }
  .main-section { margin-bottom: 24px; }
  h1.doc-title { color: #7c3aed; font-size: 22px; margin: 0 0 16px 0; font-weight: 800; border-left: 4px solid #7c3aed; padding-left: 12px; letter-spacing: 0.3px; }
  h2 { color: #16a34a; font-size: 16px; margin: 0 0 12px 0; border-left: 4px solid #16a34a; padding-left: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  h2.purple { color: #7c3aed; border-left-color: #7c3aed; }
  .text { font-size: 13px; line-height: 1.7; white-space: pre-wrap; color: #1f2937; }
  .mermaid-container { display: flex; justify-content: center; padding: 12px; background: #faf5ff; border: 1px solid #d8b4fe; border-radius: 8px; }
  .mermaid { font-size: 14px; max-width: 100%; }

  /* Footer with signature + location/date */
  .doc-footer { margin-top: 48px; page-break-inside: avoid; }
  .signature { text-align: center; margin-bottom: 24px; }
  .signature .line { width: 60%; margin: 0 auto 6px auto; border-top: 1px solid #111827; }
  .signature .name { font-size: 12.5px; font-weight: 700; color: #111827; }
  .signature .title, .signature .reg { font-size: 11.5px; color: #4b5563; margin-top: 2px; }
  .location-date { text-align: left; font-size: 11.5px; color: #4b5563; margin-top: 16px; }
</style></head><body>
  ${summaryHTML}
  <div class="doc-footer">
    <div class="signature">
      <div class="line"></div>
      ${doctor?.name ? `<div class="name">${escapeHTML(doctor.name)}</div>` : ''}
      ${doctor?.title ? `<div class="title">${escapeHTML(doctor.title)}</div>` : ''}
      ${doctor ? `<div class="reg">${escapeHTML(formatCRM(doctor))}</div>` : ''}
    </div>
    <div class="location-date">${escapeHTML(locationDate)}</div>
  </div>
</body></html>`;
}

/**
 * Returns true when the prescription should be rendered as the
 * Receituário de Controle Especial (two-copy ANVISA format).
 *
 * Triggers when ANY of the following is true:
 *   a) Template name contains "controle" / "especial" (legacy template or old recordings).
 *   b) AI summary contains [C1]–[C5] / [RDC 20] markers.
 *   c) AI summary contains a known controlled-substance name (local fallback — works
 *      even when the AI forgets to emit the explicit markers).
 */
function isControlledPrescription(templateName: string | null, body: string): boolean {
  if (templateName) {
    const t = templateName.toLowerCase();
    if (t.includes('controle') || t.includes('especial')) return true;
  }
  return hasControlledMeds(body);
}

export async function exportRecordingToPDF(input: PDFInput): Promise<void> {
  try {
    let html: string;
    const docTitle = getMedicalDocumentTitle(input.templateName);
    if (docTitle) {
      const body = input.summary ?? '';
      if (docTitle === 'Receituário Médico') {
        if (isControlledPrescription(input.templateName, body)) {
          // Receituário Controle Especial — 2 vias, formato ANVISA
          html = buildSpecialPrescriptionHTML(input);
        } else {
          // Receituário comum — template visual personalizado Dr. Brauner
          html = buildBrandedPrescriptionHTML(input);
        }
      } else {
        html = buildMedicalDocumentHTML(input, docTitle);
      }
    } else {
      html = buildGenericHTML(input);
    }

    // Samsung / Android: printToFileAsync sem outputFile explícito tenta gravar
    // no diretório temporário do sistema, que o Knox/SELinux pode bloquear.
    // Passar outputFile dentro do cacheDirectory do app resolve o problema.
    const safeDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? '';
    const stamp = Date.now();
    const outputFile = Platform.OS === 'android' && safeDir
      ? `${safeDir}evopad_${stamp}.pdf`
      : undefined; // iOS usa o caminho padrão sem problemas

    const { uri } = await Print.printToFileAsync({
      html,
      base64: false,
      ...(outputFile ? { outputFile } : {}),
    });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: `Compartilhar ${input.name}.pdf`,
        UTI: 'com.adobe.pdf',
      });
    } else {
      Alert.alert('PDF gerado', `Arquivo salvo em:\n${uri}`);
    }

    // Limpar o PDF temporário após compartilhar (best-effort)
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists) await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {
      // ignorar — arquivo temporário, sem impacto funcional
    }
  } catch (err: any) {
    Alert.alert('Erro ao exportar PDF', err?.message ?? String(err));
  }
}
