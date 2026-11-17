import React from 'react'
import { useIntl } from 'react-intl'
import { useRuntime } from 'vtex.render-runtime'
import { EmptyState, Layout, PageBlock, PageHeader } from 'vtex.styleguide'

import OrganizationMappings from './skuMapping/OrganizationMappings'
import OrganizationPicker from './skuMapping/OrganizationPicker'

/** Routes in admin/routes.json. */
const LIST_PAGE = 'admin.app.sku-mapping'
const ORGANIZATION_PAGE = 'admin.app.sku-mapping.organization'

interface Props {
  params?: { organizationId?: string }
}

/**
 * Catalog → SKU Mapping. The chosen organization goes in the URL
 * (/admin/sku-mapping/<customerId>), so a link opens it directly.
 */
const SkuMappingAdmin = ({ params }: Props) => {
  const intl = useIntl()
  const { navigate, route } = useRuntime()
  const organizationId = params?.organizationId ?? route?.params?.organizationId

  const select = (id?: string) =>
    navigate(
      id ? { page: ORGANIZATION_PAGE, params: { organizationId: id } } : { page: LIST_PAGE }
    )

  return (
    <Layout
      fullWidth
      pageHeader={
        <PageHeader
          title={intl.formatMessage({ id: 'sku-mapping.title' })}
          subtitle={intl.formatMessage({ id: 'sku-mapping.subtitle' })}
        />
      }
    >
      <PageBlock variation="full">
        <OrganizationPicker selectedId={organizationId} onSelect={select} />
      </PageBlock>
      {organizationId ? (
        <OrganizationMappings key={organizationId} organizationId={organizationId} />
      ) : (
        <PageBlock variation="full">
          <EmptyState title={intl.formatMessage({ id: 'sku-mapping.organization.none-title' })}>
            <p>{intl.formatMessage({ id: 'sku-mapping.organization.none-text' })}</p>
          </EmptyState>
        </PageBlock>
      )}
    </Layout>
  )
}

export default SkuMappingAdmin
