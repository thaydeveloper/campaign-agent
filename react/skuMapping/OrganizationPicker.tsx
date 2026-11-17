import React from 'react'
import { useQuery } from 'react-apollo'
import { useIntl } from 'react-intl'
// The searchable select is only exported under its EXPERIMENTAL_ name.
import { Alert, EXPERIMENTAL_Select as Select } from 'vtex.styleguide'

import ORGANIZATIONS from '../queries/organizations.graphql'
import { errorMessages } from './messages'
import { errorCode } from './request'
import type { Organization } from './types'

interface Props {
  selectedId?: string
  onSelect: (organizationId?: string) => void
}

type Option = { value: string; label: string }

/** Every B2B organization of the account, searchable by name. */
const OrganizationPicker = ({ selectedId, onSelect }: Props) => {
  const intl = useIntl()
  const { data, loading, error } = useQuery<{ skuMappingOrganizations: Organization[] }>(
    ORGANIZATIONS,
    { fetchPolicy: 'cache-and-network' }
  )

  const organizations = data?.skuMappingOrganizations ?? []
  const options: Option[] = organizations.map((organization) => ({
    value: organization.id,
    label: organization.name,
  }))

  const selected = options.find((option) => option.value === selectedId) ?? null

  if (error && !data) {
    return (
      <Alert type="error">
        {intl.formatMessage(errorMessages[errorCode(error)])}
      </Alert>
    )
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <Select
        label={intl.formatMessage({ id: 'sku-mapping.organization.label' })}
        placeholder={intl.formatMessage({ id: 'sku-mapping.organization.placeholder' })}
        noOptionsMessage={() => intl.formatMessage({ id: 'sku-mapping.organization.empty' })}
        multi={false}
        loading={loading && !data}
        options={options}
        value={selected}
        onChange={(option: Option | null) => onSelect(option ? option.value : undefined)}
      />
      {!loading && data && !organizations.length && (
        <p className="t-small c-muted-1 mt3 mb0">
          {intl.formatMessage({ id: 'sku-mapping.organization.no-organizations' })}
        </p>
      )}
    </div>
  )
}

export default OrganizationPicker
