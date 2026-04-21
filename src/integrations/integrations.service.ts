import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  const parsed = Number(value.toString().replace(/[$,]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeDate = (value: string | undefined) => {
  if (!value) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const parts = value.split(/[/-]/).map((part) => part.trim());
  if (parts.length === 3 && parts[2].length === 4) {
    const [month, day, year] = parts;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return value;
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
      const extractedText = await this.filesService.readTextFromReference(payload.file_url);
      const output = await this.generateStructuredResponse({
        prompt:
          'Extract the relevant data from this uploaded file and return JSON that matches the schema exactly.',
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
    return Promise.all(fileUrls.map((fileUrl) => this.filesService.readTextFromReference(fileUrl)));
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
    const schemaText = JSON.stringify(schema).toLowerCase();
    if (schemaText.includes('"transactions"')) {
      return this.extractTransactions(text);
    }

    if (schemaText.includes('"eob_lines"')) {
      return this.extractEobLines(text);
    }

    if (schemaText.includes('"claims"')) {
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
