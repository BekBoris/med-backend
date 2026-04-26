import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { basename } from 'path';
import { FilesService } from '../files/files.service';

type JsonSchema = Record<string, unknown>;

const extractJsonObject = (value: string) => {
  const trimmed = value.trim();
  const withoutCodeFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  return JSON.parse(withoutCodeFence);
};

const parseDelimitedText = (text: string) => {
  const normalized = text.trim().replace(/\r\n/g, '\n');
  if (!normalized) {
    return [];
  }

  const firstLine = normalized.split('\n')[0];
  const delimiterOptions = [',', '\t', ';', '|'];
  const delimiter = delimiterOptions.reduce((best, candidate) => {
    const candidateCount = firstLine.split(candidate).length;
    return candidateCount > firstLine.split(best).length ? candidate : best;
  }, ',');

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];

    if (inQuotes) {
      if (character === '"') {
        if (normalized[index + 1] === '"') {
          currentField += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === delimiter) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if (character === '\n') {
      currentRow.push(currentField.trim());
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
    } else {
      currentField += character;
    }
  }

  currentRow.push(currentField.trim());
  rows.push(currentRow);

  return rows.filter((row) => row.some((cell) => cell));
};

const toNumber = (value: string | undefined) => {
  if (!value) {
    return 0;
  }

  const cleaned = value
    .toString()
    .replace(/[$,]/g, '')
    .replace(/\(([^)]+)\)/g, '-$1')
    .trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeDate = (value: string | undefined) => {
  if (!value) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const spacedParts = value.trim().split(/\s+/);
  if (
    spacedParts.length === 3 &&
    spacedParts.every((part) => /^\d{1,4}$/.test(part))
  ) {
    const [month, day, year] = spacedParts;
    const normalizedYear = year.length === 2 ? `20${year}` : year;
    return `${normalizedYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const parts = value.split(/[/-]/).map((part) => part.trim());
  if (parts.length === 3 && (parts[2].length === 4 || parts[2].length === 2)) {
    const [month, day, year] = parts;
    const normalizedYear = year.length === 2 ? `20${year}` : year;
    return `${normalizedYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  if (/^\d{6}$/.test(value)) {
    const month = value.slice(0, 2);
    const day = value.slice(2, 4);
    const year = value.slice(4, 6);
    return `20${year}-${month}-${day}`;
  }

  return value;
};

const decodeHtml = (value: string) =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) =>
      String.fromCharCode(parseInt(code, 16)),
    );

const stripHtml = (value: string) =>
  decodeHtml(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const parseHtmlTableRows = (text: string) => {
  const tables = text.match(/<table[\s\S]*?<\/table>/gi) || [];
  return tables.map((table) => {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    return rows
      .map((row) => {
        const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
          (match) => stripHtml(match[1]),
        );
        return cells;
      })
      .filter((row) => row.some(Boolean));
  });
};

const firstMatch = (text: string, pattern: RegExp) => text.match(pattern)?.[1]?.trim() || '';

const compactName = (value: string) =>
  value
    .replace(/^RECEIPT DATE:\s*/i, '')
    .replace(/\bTOTALS?:.*$/i, '')
    .replace(/\b[A-Z]{2,}\d[A-Z0-9]*\b/g, '')
    .replace(/\bITSHOST\d*\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

const memberIdFromText = (value: string) =>
  value.match(/\b[A-Z]{2,}\d[A-Z0-9]*\b/)?.[0] || '';

const numbersFromText = (value: string) =>
  [...value.matchAll(/-?\$?\d[\d,]*(?:\.\d+)?-?/g)]
    .map((match) => {
      const raw = match[0].endsWith('-') ? `-${match[0].slice(0, -1)}` : match[0];
      return toNumber(raw);
    })
    .filter((amount) => Number.isFinite(amount));

const serviceLineScore = (line: Record<string, unknown>) =>
  Number(Boolean(line.patient_name)) +
  Number(Boolean(line.dos_from)) +
  Number(Boolean(line.cpt)) +
  Number((line.billed_amt as number) > 0) +
  Number((line.allowed_amt as number) > 0) +
  Number((line.provider_paid as number) !== 0);

const isUsefulEobLine = (line: Record<string, unknown>) => serviceLineScore(line) >= 3;

const isPdfFile = (mimeType: string, fileName: string) =>
  mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');

const getSchemaKind = (schema: JsonSchema) => {
  const schemaText = JSON.stringify(schema).toLowerCase();
  if (schemaText.includes('"transactions"')) {
    return 'transactions';
  }

  if (schemaText.includes('"eob_lines"')) {
    return 'eob';
  }

  if (schemaText.includes('"claims"')) {
    return 'claims';
  }

  return 'generic';
};

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly filesService: FilesService,
    private readonly configService: ConfigService,
  ) {}

  async uploadFile(file: Express.Multer.File) {
    return this.filesService.storeFile(file, 'public');
  }

  async uploadPrivateFile(file: Express.Multer.File) {
    return this.filesService.storeFile(file, 'private');
  }

  createFileSignedUrl(payload: { file_uri?: string; expires_in?: number }) {
    if (!payload.file_uri) {
      throw new BadRequestException('file_uri is required.');
    }

    return this.filesService.createSignedUrl(payload.file_uri, payload.expires_in ?? 3600);
  }

  async extractDataFromUploadedFile(payload: {
    file_url?: string;
    json_schema?: JsonSchema;
  }) {
    if (!payload.file_url || !payload.json_schema) {
      throw new BadRequestException('file_url and json_schema are required.');
    }

    try {
      const extractedText = await this.extractTextFromFileReference(payload.file_url);
      const output = await this.generateStructuredResponse({
        prompt: this.buildExtractionPrompt(payload.json_schema),
        responseJsonSchema: payload.json_schema,
        attachedFileTexts: [extractedText],
      });

      return {
        status: 'success',
        output,
      };
    } catch (error) {
      return {
        status: 'error',
        details: error instanceof Error ? error.message : 'Failed to extract data.',
      };
    }
  }

  async invokeLLM(payload: {
    prompt?: string;
    file_urls?: string[];
    response_json_schema?: JsonSchema;
  }) {
    const attachedFileTexts = await this.loadAttachedFileTexts(payload.file_urls || []);

    if (payload.response_json_schema) {
      return this.generateStructuredResponse({
        prompt: payload.prompt || '',
        responseJsonSchema: payload.response_json_schema,
        attachedFileTexts,
      });
    }

    return this.generateTextResponse({
      prompt: payload.prompt || '',
      attachedFileTexts,
    });
  }

  private async loadAttachedFileTexts(fileUrls: string[]) {
    return Promise.all(fileUrls.map((fileUrl) => this.extractTextFromFileReference(fileUrl)));
  }

  private async extractTextFromFileReference(fileReference: string) {
    const meta = await this.filesService.getFileMetaFromReference(fileReference);
    if (!isPdfFile(meta.mimeType, meta.fileName)) {
      return this.filesService.readTextFromReference(fileReference);
    }

    return this.extractPdfTextWithMineru(fileReference, meta.fileName);
  }

  private async extractPdfTextWithMineru(fileReference: string, fileName: string) {
    const serviceUrl = this.configService.get<string>(
      'MINERU_SERVICE_URL',
      'http://127.0.0.1:18080',
    );
    const endpoint = `${serviceUrl.replace(/\/+$/g, '')}/extract`;
    const fileBuffer = await this.filesService.readFileBuffer(fileReference);
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: 'application/pdf' });
    formData.append('file', blob, basename(fileName) || 'eob.pdf');

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MinerU extraction failed: ${errorText || response.statusText}`);
      }

      const result = (await response.json()) as { text?: string };
      if (!result.text?.trim()) {
        throw new Error('MinerU returned no extracted text.');
      }

      return result.text;
    } catch (error) {
      const unavailableMessage =
        `MinerU service is unavailable at ${endpoint}. Start med-services/services.py or set MINERU_SERVICE_URL.`;
      return this.extractPdfTextWithLocalFallback(
        fileReference,
        error instanceof Error ? error.message : unavailableMessage,
      );
    }
  }

  private async extractPdfTextWithLocalFallback(fileReference: string, mineruError: string) {
    try {
      const fallbackText = await this.filesService.readTextFromReference(fileReference);
      if (fallbackText.trim()) {
        return fallbackText;
      }
    } catch (error) {
      throw new ServiceUnavailableException(
        `${mineruError} Local PDF text extraction also failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }. Install mineru[all] for OCR/image-based PDFs or upload a text-based PDF.`,
      );
    }

    throw new ServiceUnavailableException(
      `${mineruError} Local PDF text extraction also returned no text. Install mineru[all] for OCR/image-based PDFs or upload a text-based PDF.`,
    );
  }

  private buildPrompt({
    prompt,
    attachedFileTexts,
    responseJsonSchema,
  }: {
    prompt: string;
    attachedFileTexts: string[];
    responseJsonSchema?: JsonSchema;
  }) {
    const sections = [prompt.trim()];

    if (attachedFileTexts.length > 0) {
      sections.push(
        attachedFileTexts
          .map(
            (text, index) =>
              `ATTACHED FILE ${index + 1}\n${text.slice(0, 60000)}`,
          )
          .join('\n\n'),
      );
    }

    if (responseJsonSchema) {
      sections.push(
        `Return strictly valid JSON that matches this schema:\n${JSON.stringify(
          responseJsonSchema,
          null,
          2,
        )}`,
      );
    }

    return sections.filter(Boolean).join('\n\n');
  }

  private buildExtractionPrompt(schema: JsonSchema) {
    const schemaKind = getSchemaKind(schema);

    if (schemaKind === 'eob') {
      return [
        'Extract structured medical EOB/ERA payment data from the attached OCR/markdown text.',
        'Return only the JSON shape requested by the schema.',
        '',
        'Required EOB batch fields:',
        '- payer_name: payer/insurance name, not provider name unless payer is absent.',
        '- check_number: check, EFT, trace, payment, or remittance number. Use empty string if absent.',
        '- check_date: payment/check/remittance date in YYYY-MM-DD when possible.',
        '',
        'Required EOB line rules:',
        '- Create one eob_lines item per service line/CPT/procedure row.',
        '- patient_name is the patient on that service line.',
        '- member_id is member/subscriber/patient account id when present.',
        '- dob is patient date of birth in YYYY-MM-DD when present.',
        '- icn should be claim number, bill number, patient control number, or claim control number.',
        '- dos_from and dos_to are service dates in YYYY-MM-DD. If only one date is present, use it for both.',
        '- cpt is the CPT/procedure code, including modifier only when it is part of the printed code.',
        '- rendering_npi is rendering/provider NPI if present.',
        '- billed_amt is submitted/charged/billed amount.',
        '- allowed_amt is allowed/contracted/eligible amount.',
        '- provider_paid is paid/provider payment amount. Use 0 for denied/unpaid lines.',
        '- patient_resp is coinsurance + copay + deductible + patient responsibility.',
        '- carc_code is CARC/adjustment/denial code when present.',
        '- remark_code is RARC/remark code when present.',
        '',
        'Normalization rules:',
        '- Convert dates like 110325 or 11/03/25 to YYYY-MM-DD.',
        '- Amounts must be numbers, not strings. Strip $, commas, parentheses, and labels.',
        '- Do not invent data. Use empty strings for missing text fields and 0 for missing numeric fields.',
        '- Preserve all service lines, even denied or zero-paid lines.',
      ].join('\n');
    }

    if (schemaKind === 'transactions') {
      return [
        'Extract payment transaction journal data from the attached text.',
        'Return only the JSON shape requested by the schema.',
        'Each transaction should include billing_number, patient_name, amount, date, chart number, provider, and transaction code when present.',
        'Amounts must be numbers. Preserve negative payments as negative amounts.',
        'Normalize dates to YYYY-MM-DD when possible.',
      ].join('\n');
    }

    if (schemaKind === 'claims') {
      return [
        'Extract medical billing claim rows from the attached text.',
        'Return only the JSON shape requested by the schema.',
        'Create one claim per patient/date of service/bill number.',
        'Group CPT/procedure rows under the matching claim when the source has multiple service lines.',
        'Normalize dates to YYYY-MM-DD and amounts to numbers.',
      ].join('\n');
    }

    return 'Extract the relevant data from this uploaded file and return JSON that matches the schema exactly.';
  }

  private async generateTextResponse({
    prompt,
    attachedFileTexts,
  }: {
    prompt: string;
    attachedFileTexts: string[];
  }) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      return 'LLM provider is not configured. Set OPENAI_API_KEY in med-backend to enable AI responses.';
    }

    return this.callOpenAi({
      prompt: this.buildPrompt({ prompt, attachedFileTexts }),
      expectJson: false,
    });
  }

  private async generateStructuredResponse({
    prompt,
    responseJsonSchema,
    attachedFileTexts,
  }: {
    prompt: string;
    responseJsonSchema: JsonSchema;
    attachedFileTexts: string[];
  }) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      return this.fallbackStructuredExtraction(responseJsonSchema, attachedFileTexts.join('\n\n'));
    }

    const rawResponse = await this.callOpenAi({
      prompt: this.buildPrompt({
        prompt,
        attachedFileTexts,
        responseJsonSchema,
      }),
      expectJson: true,
    });

    return extractJsonObject(rawResponse);
  }

  private async callOpenAi({
    prompt,
    expectJson,
  }: {
    prompt: string;
    expectJson: boolean;
  }) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const model = this.configService.get<string>('OPENAI_MODEL', 'gpt-4o-mini');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: expectJson ? 0 : 0.2,
        response_format: expectJson ? { type: 'json_object' } : undefined,
        messages: [
          {
            role: 'system',
            content: expectJson
              ? 'You extract structured data. Return JSON only and do not wrap it in markdown.'
              : 'You are a concise medical billing assistant.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new BadGatewayException(`OpenAI request failed: ${errorBody}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content.map((item) => item.text || '').join('\n').trim();
    }

    throw new BadGatewayException('OpenAI returned an empty response.');
  }

  private fallbackStructuredExtraction(schema: JsonSchema, text: string) {
    const schemaKind = getSchemaKind(schema);
    if (schemaKind === 'transactions') {
      return this.extractTransactions(text);
    }

    if (schemaKind === 'eob') {
      return this.extractEobLines(text);
    }

    if (schemaKind === 'claims') {
      return this.extractClaims(text);
    }

    throw new ServiceUnavailableException(
      'Structured AI extraction requires OPENAI_API_KEY for this input shape.',
    );
  }

  private extractClaims(text: string) {
    const rows = parseDelimitedText(text);
    if (rows.length < 2) {
      return { claims: [] };
    }

    const headers = rows[0].map((header) => header.toLowerCase());
    const dataRows = rows.slice(1);
    const findIndex = (patterns: string[]) =>
      headers.findIndex((header) => patterns.some((pattern) => header.includes(pattern)));

    const patientIndex = findIndex(['patient name', 'patient']);
    const dobIndex = findIndex(['patient dob', 'dob', 'date of birth']);
    const providerIndex = findIndex(['provider', 'doctor', 'dr']);
    const dosIndex = findIndex(['date of service', 'service date', 'dos']);
    const insuranceIndex = findIndex(['insurance']);
    const billIndex = findIndex(['bill number', 'billing number', 'bill']);
    const singleCptIndex = findIndex(['cpt']);
    const singleAmountIndex = findIndex(['amount billed', 'billed amount', 'amount']);

    const claims = dataRows
      .map((row) => {
        const cptCodes: Array<Record<string, unknown>> = [];
        if (singleCptIndex >= 0 && row[singleCptIndex]) {
          cptCodes.push({
            code: row[singleCptIndex],
            description: '',
            amount_billed: toNumber(row[singleAmountIndex]),
          });
        }

        return {
          patient_name: row[patientIndex] || '',
          patient_dob: normalizeDate(row[dobIndex]),
          provider: row[providerIndex] || '',
          date_of_service: normalizeDate(row[dosIndex]),
          insurance_company: row[insuranceIndex] || '',
          bill_number: row[billIndex] || '',
          cpt_codes: cptCodes,
        };
      })
      .filter((claim) => claim.patient_name || claim.date_of_service);

    return { claims };
  }

  private extractEobLines(text: string) {
    const mineruTableResult = this.extractMineruTableEobLines(text);
    if (mineruTableResult.eob_lines.length > 0) {
      return mineruTableResult;
    }

    const rows = parseDelimitedText(text);
    if (rows.length < 2) {
      return {
        payer_name: '',
        check_number: '',
        check_date: '',
        eob_lines: [],
      };
    }

    const headers = rows[0].map((header) => header.toLowerCase());
    const dataRows = rows.slice(1);
    const getIndex = (patterns: string[]) =>
      headers.findIndex((header) => patterns.some((pattern) => header.includes(pattern)));

    const payerIndex = getIndex(['payer', 'insurance']);
    const checkNumberIndex = getIndex(['check number', 'check']);
    const checkDateIndex = getIndex(['check date', 'date']);
    const patientIndex = getIndex(['patient']);
    const memberIndex = getIndex(['member']);
    const dobIndex = getIndex(['dob', 'date of birth']);
    const icnIndex = getIndex(['icn', 'claim number', 'bill number']);
    const dosIndex = getIndex(['dos', 'service date']);
    const cptIndex = getIndex(['cpt', 'procedure']);
    const npiIndex = getIndex(['npi', 'rendering']);
    const billedIndex = getIndex(['billed']);
    const allowedIndex = getIndex(['allowed']);
    const paidIndex = getIndex(['paid', 'payment']);
    const patientRespIndex = getIndex(['patient resp', 'patient responsibility']);
    const carcIndex = getIndex(['carc']);
    const remarkIndex = getIndex(['remark']);

    const eobLines = dataRows.map((row) => ({
      patient_name: row[patientIndex] || '',
      member_id: row[memberIndex] || '',
      dob: normalizeDate(row[dobIndex]),
      icn: row[icnIndex] || '',
      dos_from: normalizeDate(row[dosIndex]),
      dos_to: normalizeDate(row[dosIndex]),
      cpt: row[cptIndex] || '',
      rendering_npi: row[npiIndex] || '',
      billed_amt: toNumber(row[billedIndex]),
      allowed_amt: toNumber(row[allowedIndex]),
      provider_paid: toNumber(row[paidIndex]),
      patient_resp: toNumber(row[patientRespIndex]),
      carc_code: row[carcIndex] || '',
      remark_code: row[remarkIndex] || '',
    }));

    return {
      payer_name: dataRows[0]?.[payerIndex] || '',
      check_number: dataRows[0]?.[checkNumberIndex] || '',
      check_date: normalizeDate(dataRows[0]?.[checkDateIndex]),
      eob_lines: eobLines.filter(isUsefulEobLine),
    };
  }

  private extractMineruTableEobLines(text: string) {
    const blueShieldResult = this.extractBlueShieldEobLines(text);
    if (blueShieldResult.eob_lines.length > 0) {
      return blueShieldResult;
    }

    return {
      payer_name: this.inferPayerName(text),
      check_number: firstMatch(text, /(?:CHECK|EFT|TRACE|PAYMENT)[/#\s-]*(?:NUMBER|NO\.?)[:\s]*([A-Z0-9-]+)/i),
      check_date: normalizeDate(firstMatch(text, /(?:CHECK|ISSUE|PAYMENT|REMITTANCE)\s*DATE[:\s]*([0-9/ -]{6,10})/i)),
      eob_lines: [],
    };
  }

  private inferPayerName(text: string) {
    const normalized = text.toLowerCase();
    if (normalized.includes('blueshieldca.com') || normalized.includes('blue shield')) {
      return 'Blue Shield of California';
    }

    if (normalized.includes('anthem blue cross')) {
      return 'Anthem Blue Cross';
    }

    if (normalized.includes('medicare')) {
      return 'Medicare';
    }

    if (normalized.includes('unitedhealthcare') || normalized.includes('uhc')) {
      return 'UnitedHealthcare';
    }

    return '';
  }

  private extractBlueShieldEobLines(text: string) {
    if (!/blue\s*shield|blueshieldca\.com/i.test(text)) {
      return {
        payer_name: '',
        check_number: '',
        check_date: '',
        eob_lines: [],
      };
    }

    const checkNumber = firstMatch(text, /CHECK\/EFT NUMBER:\s*([A-Z0-9-]+)/i);
    const eobNumber = firstMatch(text, /EOB NUMBER:\s*([A-Z0-9-]+)/i);
    const issueDateBlock = text.match(/ISSUE DATE:([\s\S]{0,180}?)(?:EOB NUMBER|PHYSICIAN|PROVIDER NUMBER)/i)?.[1] || '';
    const issueDateCandidates = [...issueDateBlock.matchAll(/\b\d{1,2}\s+\d{1,2}\s+\d{2,4}\b/g)].map(
      (match) => match[0],
    );
    const issueDate = normalizeDate(issueDateCandidates.at(-1));
    const tables = parseHtmlTableRows(text);
    const eobLines: Array<Record<string, unknown>> = [];

    for (const rows of tables) {
      const headerIndex = rows.findIndex((row) =>
        row.join(' ').toLowerCase().includes('patientname') &&
        row.join(' ').toLowerCase().includes('amount paid'),
      );
      const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
      let pendingFirstName = '';

      for (let index = 0; index < dataRows.length; index += 1) {
        const row = dataRows[index];
        const firstCell = row[0] || '';

        if (/^RECEIPT DATE:/i.test(firstCell)) {
          const receiptName = compactName(firstCell);
          if (receiptName) {
            pendingFirstName = receiptName;
          }
        }

        const dosIndex = row.findIndex(
          (cell, cellIndex) =>
            cellIndex >= 2 && /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(cell),
        );
        const cptIndex = row.findIndex(
          (cell, cellIndex) =>
            cellIndex > dosIndex && /\b9\d{4}\b/.test(cell),
        );
        if (cptIndex < 0 || dosIndex < 0 || row.length < 6 || /^TOTALS?:/i.test(firstCell)) {
          continue;
        }

        const continuationRow = dataRows[index + 1] || [];
        const continuationFirstCell = continuationRow[0] || '';
        const accountAndReceipt = row[1] || '';
        const claimNumber =
          continuationRow[1] && /^\d{6,}$/.test(continuationRow[1].replace(/\D/g, ''))
            ? continuationRow[1]
            : '';
        const firstNameFromRow = /^RECEIPT DATE:/i.test(firstCell)
          ? compactName(firstCell)
          : pendingFirstName;
        const lastNameFromRow = /^RECEIPT DATE:/i.test(firstCell)
          ? compactName(continuationFirstCell)
          : compactName(firstCell);
        const patientName = [firstNameFromRow, lastNameFromRow].filter(Boolean).join(' ').trim();
        const memberId = memberIdFromText(firstCell) || memberIdFromText(continuationFirstCell);
        const cpt = row[cptIndex].match(/\b9\d{4}\b/)?.[0] || '';
        const dateOfService = normalizeDate(row[dosIndex].match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/)?.[0]);
        const numericCells = row
          .slice(cptIndex + 1)
          .flatMap((cell) => numbersFromText(cell));
        const amountCells =
          numericCells.length > 2 && Math.abs(numericCells[0]) <= 20
            ? numericCells.slice(1)
            : numericCells;
        const billedAmount = amountCells[0] || 0;
        const allowedAmount = amountCells[1] || 0;
        const providerPaid = amountCells.at(-1) || 0;
        const patientResponsibility = (amountCells.at(-3) || 0) + (amountCells.at(-2) || 0);
        const accountNumber =
          accountAndReceipt.match(/\b\d{4,}-\d+\b/)?.[0] ||
          accountAndReceipt.match(/\b\d{6,}\b/)?.[0] ||
          '';

        const line = {
          patient_name: patientName,
          member_id: memberId,
          dob: '',
          icn: claimNumber || accountNumber || eobNumber,
          dos_from: dateOfService,
          dos_to: dateOfService,
          cpt,
          rendering_npi: firstMatch(text, /PROVIDER NPI:\s*(\d+)/i),
          billed_amt: billedAmount,
          allowed_amt: allowedAmount,
          provider_paid: providerPaid,
          patient_resp: patientResponsibility,
          carc_code: '',
          remark_code: '',
        };

        if (isUsefulEobLine(line)) {
          eobLines.push(line);
        }
      }
    }

    return {
      payer_name: 'Blue Shield of California',
      check_number: checkNumber || eobNumber,
      check_date: issueDate,
      eob_lines: eobLines,
    };
  }

  private extractTransactions(text: string) {
    const rows = parseDelimitedText(text);
    if (rows.length < 2) {
      return {
        report_title: '',
        report_date: '',
        provider_name: '',
        transactions: [],
        total_insurance_payment: 0,
      };
    }

    const headers = rows[0].map((header) => header.toLowerCase());
    const dataRows = rows.slice(1);
    const getIndex = (patterns: string[]) =>
      headers.findIndex((header) => patterns.some((pattern) => header.includes(pattern)));

    const chartIndex = getIndex(['chart']);
    const patientIndex = getIndex(['patient']);
    const billingIndex = getIndex(['billing number', 'bill number']);
    const dateIndex = getIndex(['date']);
    const providerIndex = getIndex(['provider']);
    const codeIndex = getIndex(['code', 'tx']);
    const amountIndex = getIndex(['amount', 'payment']);

    const transactions = dataRows.map((row) => ({
      chart_number: row[chartIndex] || '',
      patient_name: row[patientIndex] || '',
      billing_number: row[billingIndex] || '',
      date: normalizeDate(row[dateIndex]),
      provider: row[providerIndex] || '',
      tx_code: row[codeIndex] || '',
      amount: toNumber(row[amountIndex]),
    }));

    return {
      report_title: 'Uploaded Transaction Journal',
      report_date: normalizeDate(dataRows[0]?.[dateIndex]),
      provider_name: dataRows[0]?.[providerIndex] || '',
      transactions,
      total_insurance_payment: transactions.reduce((sum, txn) => sum + Math.abs(txn.amount), 0),
    };
  }
}
