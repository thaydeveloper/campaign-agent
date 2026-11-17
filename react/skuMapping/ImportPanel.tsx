import React, { useEffect, useState } from 'react'
import { useApolloClient } from 'react-apollo'
import { FormattedMessage, useIntl } from 'react-intl'
import { Alert, Button, Dropzone, Progress } from 'vtex.styleguide'
import type { DocumentNode } from 'graphql'

import ADD_CHUNK from '../queries/addChunk.graphql'
import CANCEL_IMPORT from '../queries/cancelImport.graphql'
import FINISH_IMPORT from '../queries/finishImport.graphql'
import START_IMPORT from '../queries/startImport.graphql'
import {
  chunkMappings,
  MAX_CSV_BYTES,
  MAX_XLSX_BYTES,
  parseMappingCsv,
  parseMappingXlsx,
  toChunkRows,
} from './mappingFile'
import type { MappingFileResult } from './mappingFile'
import { errorMessages, importMessages } from './messages'
import { errorCode, withRetries } from './request'
import { downloadTemplate } from './template'
import type { ImportSummary } from './types'

type Checked = { fileName: string; result: MappingFileResult }
type Sending = { sent: number; total: number }
type Finished = { inserted: number; updated: number; total: number; rejected: number }

interface Props {
  organizationId: string
  activeImport: ImportSummary | null
  /** Called after an import ends or is cancelled, to reload the summary and the table. */
  onChanged: () => void
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const ImportPanel = ({ organizationId, activeImport, onChanged }: Props) => {
  const intl = useIntl()
  const client = useApolloClient()
  const [reading, setReading] = useState(false)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [sending, setSending] = useState<Sending | null>(null)
  const [finished, setFinished] = useState<Finished | null>(null)
  const [error, setError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  // A new key gives a fresh Dropzone, without the file it last showed.
  const [dropzoneKey, setDropzoneKey] = useState(0)
  const importing = sending !== null

  useEffect(() => {
    if (!importing) return undefined
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', warn)

    return () => window.removeEventListener('beforeunload', warn)
  }, [importing])

  const text = (message: { id: string }, values?: Record<string, string | number>) =>
    intl.formatMessage(message, values)

  const date = (value: string) =>
    intl.formatDate(value, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  async function mutate<T>(mutation: DocumentNode, variables: Record<string, unknown>) {
    const { data } = await client.mutate<T>({ mutation, variables, fetchPolicy: 'no-cache' })

    if (!data) throw new Error('Empty response')

    return data
  }

  function reset() {
    setChecked(null)
    setError('')
    setDropzoneKey((key) => key + 1)
  }

  async function check(file: File) {
    setError('')
    setFinished(null)
    setChecked(null)
    const excel = /\.xlsx$/i.test(file.name)

    if (!excel && !/\.(csv|txt)$/i.test(file.name)) {
      setError(text(importMessages.wrongType))

      return
    }

    if (file.size > (excel ? MAX_XLSX_BYTES : MAX_CSV_BYTES)) {
      setError(text(excel ? importMessages.tooBigXlsx : importMessages.tooBigCsv))

      return
    }

    setReading(true)
    await wait(0) // let "Checking…" paint before a large file is parsed
    try {
      const result = excel
        ? await parseMappingXlsx(await file.arrayBuffer())
        : parseMappingCsv(await file.text())

      setChecked({ fileName: file.name, result })
    } catch (failure) {
      setError(text(importMessages.unreadable))
    } finally {
      setReading(false)
    }
  }

  async function runImport() {
    if (!checked) return
    const { mappings, rejectedRows } = checked.result

    setError('')
    setFinished(null)
    setSending({ sent: 0, total: mappings.length })
    let importId: number | undefined
    let sent = 0

    try {
      const started = await mutate<{ startSkuMappingImport: { importId: number } }>(
        START_IMPORT,
        { organizationId, fileName: checked.fileName.slice(0, 255) }
      )

      importId = started.startSkuMappingImport.importId

      for (const chunk of chunkMappings(mappings)) {
        // A chunk sent twice changes nothing, so it is retried.
        await withRetries(() =>
          mutate(ADD_CHUNK, { organizationId, importId, rows: toChunkRows(chunk) })
        )
        sent += chunk.length
        setSending({ sent, total: mappings.length })
      }

      const done = await mutate<{
        finishSkuMappingImport: { inserted: number; updated: number; total: number }
      }>(FINISH_IMPORT, { organizationId, importId, rejectedRows })

      setFinished({ ...done.finishSkuMappingImport, rejected: rejectedRows })
      setChecked(null)
      setDropzoneKey((key) => key + 1)
    } catch (failure) {
      if (importId) {
        await mutate(CANCEL_IMPORT, { organizationId, importId }).catch(() => undefined)
      }

      const reason = text(errorMessages[errorCode(failure)])

      setError(sent ? `${reason} ${text(importMessages.stoppedPartial, { saved: sent })}` : reason)
    } finally {
      setSending(null)
      onChanged()
    }
  }

  async function cancelActive(id: number) {
    setCancelling(true)
    setError('')
    try {
      await mutate(CANCEL_IMPORT, { organizationId, importId: id })
      onChanged()
    } catch (failure) {
      setError(text(errorMessages[errorCode(failure)]))
    } finally {
      setCancelling(false)
    }
  }

  const blockedByOther = !!activeImport && !activeImport.mine && !importing
  const result = checked?.result

  return (
    <div>
      <h3 className="t-heading-5 mt0 mb3">
        <FormattedMessage id="sku-mapping.import.title" />
      </h3>
      <p className="t-body c-muted-1 mt0 mb3">
        <FormattedMessage id="sku-mapping.import.description" />
      </p>
      <div className="flex flex-wrap items-center mb4">
        <span className="t-small c-muted-1 mr3">
          <FormattedMessage id="sku-mapping.import.leading-zeros" />
        </span>
        <Button variation="tertiary" size="small" onClick={downloadTemplate}>
          <FormattedMessage id="sku-mapping.import.template" />
        </Button>
      </div>

      {activeImport && !importing && (
        <div className="mb4">
          <Alert type="warning">
            {activeImport.mine ? (
              <div>
                <p className="mt0 mb3">
                  {text(importMessages.activeMine, {
                    fileName: activeImport.fileName,
                    date: date(activeImport.startedAt),
                  })}
                </p>
                <Button
                  variation="secondary"
                  size="small"
                  isLoading={cancelling}
                  onClick={() => cancelActive(activeImport.id)}
                >
                  <FormattedMessage id="sku-mapping.import.cancel-active" />
                </Button>
              </div>
            ) : (
              text(importMessages.activeOther, {
                fileName: activeImport.fileName,
                date: date(activeImport.startedAt),
              })
            )}
          </Alert>
        </div>
      )}

      {!importing && !blockedByOther && (
        <Dropzone
          key={dropzoneKey}
          isLoading={reading}
          onDropAccepted={(files: File[]) => {
            if (files[0]) check(files[0])
          }}
          onFileReset={reset}
        >
          <div className="pt7 pb7">
            <span className="f5">
              <FormattedMessage id="sku-mapping.import.dropzone" />{' '}
            </span>
            <span className="f5 c-link pointer">
              <FormattedMessage id="sku-mapping.import.dropzone-link" />
            </span>
          </div>
        </Dropzone>
      )}
      {reading && (
        <p className="t-small c-muted-1" role="status">
          <FormattedMessage id="sku-mapping.import.checking" />
        </p>
      )}

      {checked && result && !importing && (
        <div className="mt5">
          <h4 className="t-heading-6 mt0 mb3">{checked.fileName}</h4>
          <ul className="mt0 mb4 pl5 t-body lh-copy">
            <li>
              <strong>{text(importMessages.ready, { count: result.mappings.length })}</strong>
            </li>
            {result.rejectedRows > 0 && (
              <li>{text(importMessages.rejected, { count: result.rejectedRows })}</li>
            )}
            {result.duplicateRows > 0 && (
              <li>{text(importMessages.duplicates, { count: result.duplicateRows })}</li>
            )}
            {result.numericCells > 0 && (
              <li>{text(importMessages.numeric, { count: result.numericCells })}</li>
            )}
          </ul>
          {result.numericCells > 0 && (
            <div className="mb4">
              <Alert type="warning">
                {text(importMessages.numericWarning)} {text(importMessages.leadingZeros)}
              </Alert>
            </div>
          )}
          {result.errors.length > 0 && (
            <details className="mb4" open={result.errors.length <= 5}>
              <summary className="pointer t-body">
                {result.rejectedRows > result.errors.length
                  ? text(importMessages.errorsPartial, {
                      shown: result.errors.length,
                      total: result.rejectedRows,
                    })
                  : text(importMessages.errors)}
              </summary>
              <ul className="mt3 pl5 t-small lh-copy">
                {result.errors.map((entry) => (
                  <li key={entry.row}>{entry.message}</li>
                ))}
              </ul>
            </details>
          )}
          {result.fatal ? (
            <Alert type="error">{result.fatal}</Alert>
          ) : (
            <div className="flex flex-wrap">
              <div className="mr3 mb3">
                <Button variation="primary" onClick={runImport}>
                  {text(importMessages.start, { count: result.mappings.length })}
                </Button>
              </div>
              <Button variation="secondary" onClick={reset}>
                <FormattedMessage id="sku-mapping.import.other-file" />
              </Button>
            </div>
          )}
        </div>
      )}

      {sending && (
        <div className="mt5" role="status">
          <Progress
            type="line"
            percent={Math.floor((sending.sent / Math.max(sending.total, 1)) * 100)}
          />
          <p className="t-small c-muted-1">
            {text(importMessages.progress, { sent: sending.sent, total: sending.total })}
          </p>
        </div>
      )}

      {finished && (
        <div className="mt5">
          <Alert type="success" onClose={() => setFinished(null)}>
            {text(importMessages.done, finished)}
          </Alert>
        </div>
      )}

      {error && (
        <div className="mt5">
          <Alert type="error" onClose={() => setError('')}>
            {error}
          </Alert>
        </div>
      )}
    </div>
  )
}

export default ImportPanel
