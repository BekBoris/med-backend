import { ResourceEntityName } from '../common/constants/entities.constant';

export type ResourceProtectionPolicy = {
  protectedFields: string[];
  blindIndexes?: Record<string, string>;
};

export const RESOURCE_PROTECTION_POLICIES: Partial<
  Record<ResourceEntityName, ResourceProtectionPolicy>
> = {
  Patient: {
    protectedFields: ['name', 'date_of_birth', 'preventative_cpts'],
    blindIndexes: {
      name: 'name__idx',
    },
  },
  Claim: {
    protectedFields: [
      'patient_name',
      'patient_dob',
      'insurance_company',
      'bill_number',
      'secondary_check_number',
      'eob_number',
      'cpt_codes',
    ],
  },
  EOBLine: {
    protectedFields: [
      'patient_name',
      'member_id',
      'dob',
      'icn',
      'check_number',
      'trace_no',
      'notes',
    ],
  },
  EOBBatch: {
    protectedFields: ['check_number'],
  },
};

export const getResourceProtectionPolicy = (entityName: ResourceEntityName) =>
  RESOURCE_PROTECTION_POLICIES[entityName];
