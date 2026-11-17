import React, { useState } from 'react'
import { useQuery } from 'react-apollo'
import { FormattedMessage, useIntl } from 'react-intl'
import { Alert, PageBlock, Spinner } from 'vtex.styleguide'

import OVERVIEW from '../queries/overview.graphql'
import ImportPanel from './ImportPanel'
import MappingTable from './MappingTable'
import { errorMessages, overviewMessages } from './messages'
import { errorCode } from './request'
import type { ImportSummary, Overview } from './types'

interface Props {
  organizationId: string
}

/** Summary, upload and table of one organization's mappings. */
const OrganizationMappings = ({ organizationId }: Props) => {
  const intl = useIntl()
  const [tableVersion, setTableVersion] = useState(0)
  const { data, error, refetch } = useQuery<{ skuMappingOverview: Overview }>(OVERVIEW, {
    variables: { organizationId },
    fetchPolicy: 'network-only',
  })

  const overview = data?.skuMappingOverview

  const refresh = () => {
    // A failure shows through `error`.
    refetch().catch(() => undefined)
    setTableVersion((version) => version + 1)
  }

  const date = (iso: string) =>
    intl.formatDate(iso, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  const lastImportText = (run: ImportSummary) =>
    intl.formatMessage(
      run.status === 'completed' ? overviewMessages.lastImport : overviewMessages.lastImportStopped,
      {
        date: date(run.finishedAt ?? run.startedAt),
        inserted: run.inserted,
        updated: run.updated,
        rejected: run.rejected,
      }
    )

  if (error && !overview) {
    return (
      <PageBlock variation="full">
        <Alert type="error">
          {intl.formatMessage(errorMessages[errorCode(error)])}
        </Alert>
      </PageBlock>
    )
  }

  if (!overview) {
    return (
      <PageBlock variation="full">
        <div className="flex justify-center pv8">
          <Spinner />
        </div>
      </PageBlock>
    )
  }

  return (
    <>
      <PageBlock variation="full">
        <div className="flex flex-wrap">
          <div className="w-100 w-30-l pr6-l mb6">
            <div className="t-heading-1 c-on-base">{intl.formatNumber(overview.total)}</div>
            <div className="t-body c-muted-1 mb5">
              {intl.formatMessage(
                { id: 'sku-mapping.overview.total' },
                { count: overview.total }
              )}
            </div>
            {overview.lastImport ? (
              <div>
                <div className="t-body c-on-base b break-word">
                  {overview.lastImport.fileName}
                </div>
                <div className="t-small c-muted-1">{lastImportText(overview.lastImport)}</div>
              </div>
            ) : (
              <div className="t-small c-muted-1">
                <FormattedMessage id="sku-mapping.overview.no-imports" />
              </div>
            )}
          </div>
          <div className="w-100 w-70-l">
            <ImportPanel
              organizationId={organizationId}
              activeImport={overview.activeImport}
              onChanged={refresh}
            />
          </div>
        </div>
      </PageBlock>
      <PageBlock
        variation="full"
        title={intl.formatMessage({ id: 'sku-mapping.table.title' })}
      >
        <MappingTable organizationId={organizationId} version={tableVersion} />
      </PageBlock>
    </>
  )
}

export default OrganizationMappings
