import React, { useEffect, useState } from 'react'
import { useQuery } from 'react-apollo'
import { FormattedMessage, useIntl } from 'react-intl'
import { Alert, Button, EmptyState, InputSearch, Spinner } from 'vtex.styleguide'

import MAPPINGS from '../queries/mappings.graphql'
import { errorMessages } from './messages'
import { errorCode } from './request'
import type { MappingPage } from './types'

/** Characters a code can have: anything else never searches. */
const PREFIX = /^[A-Za-z0-9._-]*$/
const DEBOUNCE_MS = 300

interface Props {
  organizationId: string
  /** Increases after each import: reload from the first page. */
  version: number
}

type Cursor = { after?: string; before?: string }

const cellClass = 'pv3 ph4 bb b--muted-5 tl'
const headerClass = 'pv3 ph4 bb b--muted-4 tl t-small c-muted-1 fw5'

/**
 * Searches while typing, 300 ms after the last key (Enter searches at once),
 * by the start of the code whatever its case. 50 per page, by cursor.
 */
const MappingTable = ({ organizationId, version }: Props) => {
  const intl = useIntl()
  const [value, setValue] = useState('')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState<Cursor>({})
  const [shown, setShown] = useState<MappingPage | null>(null)
  const prefix = value.trim()
  const valid = PREFIX.test(prefix)

  const search = (next: string) => {
    setQuery(next)
    setCursor({})
  }

  useEffect(() => {
    if (!valid || prefix === query) return undefined
    const timer = setTimeout(() => {
      setQuery(prefix)
      setCursor({})
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [prefix, query, valid])

  const { data, loading, error, refetch } = useQuery<{ skuMappings: MappingPage }>(MAPPINGS, {
    variables: {
      organizationId,
      query: query || null,
      after: cursor.after ?? null,
      before: cursor.before ?? null,
    },
    fetchPolicy: 'network-only',
    notifyOnNetworkStatusChange: true,
  })

  // Keeps the last page on screen while the next one loads.
  useEffect(() => {
    if (data?.skuMappings) setShown(data.skuMappings)
  }, [data])

  useEffect(() => {
    if (!version) return
    if (cursor.after || cursor.before) setCursor({})
    else refetch().catch(() => undefined) // a failure shows through `error`
    // Only an import (a new version) reloads; cursor and refetch are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const date = (iso: string) =>
    intl.formatDate(iso, { day: '2-digit', month: '2-digit', year: 'numeric' })

  return (
    <div>
      <div className="mb4" style={{ maxWidth: 420 }}>
        <InputSearch
          value={value}
          maxLength={80}
          autoComplete="off"
          placeholder={intl.formatMessage({ id: 'sku-mapping.table.search' })}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value)}
          onClear={() => setValue('')}
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault()
            if (valid && prefix !== query) search(prefix)
          }}
        />
        {!valid && (
          <p className="t-small c-danger mt2 mb0">
            <FormattedMessage id="sku-mapping.table.search-invalid" />
          </p>
        )}
      </div>

      {error && (
        <div className="mb4">
          <Alert type="error">
            {intl.formatMessage(errorMessages[errorCode(error)])}
          </Alert>
        </div>
      )}

      {!shown && loading && (
        <div className="flex justify-center pv6">
          <Spinner />
        </div>
      )}

      {shown && shown.rows.length === 0 && (
        <EmptyState
          title={
            query
              ? intl.formatMessage({ id: 'sku-mapping.table.no-match-title' }, { query })
              : intl.formatMessage({ id: 'sku-mapping.table.empty-title' })
          }
        >
          <p>
            {query ? (
              <FormattedMessage id="sku-mapping.table.no-match-text" />
            ) : (
              <FormattedMessage id="sku-mapping.table.empty-text" />
            )}
          </p>
        </EmptyState>
      )}

      {shown && shown.rows.length > 0 && (
        <div className="overflow-x-auto" style={{ opacity: loading ? 0.6 : 1 }}>
          <table className="w-100 t-body" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className={headerClass} scope="col">
                  owner_sku
                </th>
                <th className={headerClass} scope="col">
                  vtex_sku
                </th>
                <th className={headerClass} scope="col">
                  <FormattedMessage id="sku-mapping.table.updated" />
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((row) => (
                <tr key={row.ownerSku}>
                  <td className={`${cellClass} code`}>{row.ownerSku}</td>
                  <td className={`${cellClass} code`}>{row.vtexSku}</td>
                  <td className={`${cellClass} c-muted-1`}>{date(row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shown && (shown.previous || shown.next) && (
        <div className="flex justify-end mt4">
          <div className="mr3">
            <Button
              variation="secondary"
              size="small"
              disabled={!shown.previous || loading}
              onClick={() => shown.previous && setCursor({ before: shown.previous })}
            >
              <FormattedMessage id="sku-mapping.table.previous" />
            </Button>
          </div>
          <Button
            variation="secondary"
            size="small"
            disabled={!shown.next || loading}
            onClick={() => shown.next && setCursor({ after: shown.next })}
          >
            <FormattedMessage id="sku-mapping.table.next" />
          </Button>
        </div>
      )}
    </div>
  )
}

export default MappingTable
