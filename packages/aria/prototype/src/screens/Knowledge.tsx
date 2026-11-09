/**
 * Knowledge: the collections Aria can read, the search field, and the resource
 * list with its source metadata.
 *
 * Searching is local substring matching over title, source, and tags. Two states
 * are shown deliberately: a collection that is not indexed (so the interface has
 * to say why it cannot be cited) and a search with no result.
 */

import { useMemo, useState } from 'react'
import { Button } from '../components/primitives.tsx'
import { FilterRow, PageHeader, PrototypeNotice, SearchField } from '../components/Controls.tsx'
import { Panel, SectionHeading } from '../components/Panel.tsx'
import { RegionState } from '../components/Feedback.tsx'
import { Tag } from '../components/Record.tsx'
import { StatusDot } from '../components/Status.tsx'
import { GlyphArrowRight } from '../components/icons.tsx'
import { relativeAge } from '../format.ts'
import type { KnowledgeCollection, KnowledgeResource, Workspace } from '../model.ts'
import type { Translate } from '../locales/index.ts'
import css from './Knowledge.module.css'

/** Page size of the resource list before "load more". */
const PAGE_SIZE = 8

/**
 * Render the knowledge screen.
 * @param props.workspace - the demonstration workspace.
 * @param props.now - reference moment for relative ages.
 * @param props.onOpenMission - moves to the mission register.
 * @param props.t - the dictionary resolver.
 * @returns the knowledge screen.
 */
export function Knowledge({ workspace, now, onOpenMission, t }: {
  workspace: Workspace
  now: string
  onOpenMission: () => void
  t: Translate
}) {
  const [collection, setCollection] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)

  const needle = query.trim().toLowerCase()
  const resources = useMemo(() => {
    return workspace.resources.filter(resource => {
      if (collection !== 'all' && resource.collectionId !== collection) return false
      if (needle === '') return true
      return resource.title.toLowerCase().includes(needle)
        || resource.source.toLowerCase().includes(needle)
        || resource.tags.some(tag => tag.toLowerCase().includes(needle))
    })
  }, [workspace.resources, collection, needle])

  const shown = resources.slice(0, limit)
  const activeCollection = workspace.collections.find(item => item.id === collection)
  const filters: readonly { value: string, label: string, count: number }[] = [
    { value: 'all', label: t('knowledge.allCollections'), count: workspace.resources.length },
    ...workspace.collections.map(item => ({
      value: item.id,
      label: item.name,
      count: workspace.resources.filter(resource => resource.collectionId === item.id).length,
    })),
  ]

  const unindexed = workspace.collections.find(item => !item.indexed)

  return (
    <>
      <PageHeader
        title={t('knowledge.title')}
        subtitle={t('knowledge.subtitle')}
        eyebrow={`${workspace.name} · ${t('knowledge.titleCount', { count: workspace.collections.length, resources: workspace.resources.length })}`}
        titleId="aria-knowledge-title"
        actions={(
          <Button variant="outline" onClick={onOpenMission}>
            {t('overview.activeMissions')}
          </Button>
        )}
      />

      <div className={css.columns}>
        <aside className={css.rail} aria-label={t('knowledge.collections')}>
          <h2 className={css.railTitle}>{t('knowledge.collections')}</h2>
          <ul className={css.collectionList}>
            {workspace.collections.map(item => {
              const active = collection === item.id
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={css.collection}
                    data-active={active || undefined}
                    aria-pressed={active}
                    onClick={() => { setCollection(active ? 'all' : item.id); setLimit(PAGE_SIZE) }}
                  >
                    <span className={css.collectionHead}>
                      <span className={css.collectionName}>{item.name}</span>
                      <StatusDot tone={item.indexed ? 'active' : 'idle'} size={6} />
                    </span>
                    <span className={css.collectionSummary}>{item.summary}</span>
                    <span className={css.collectionMeta}>
                      <span>{t('knowledge.count', { count: item.count })}</span>
                      <span aria-hidden="true">·</span>
                      <span>{item.clearance}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {unindexed === undefined ? null : (
            <div className={css.railFoot}>
              <p className={css.railNote}>{t('knowledge.noIndexTitle')}</p>
              <p className={css.railNoteMuted}>{t('knowledge.noIndexBody')}</p>
            </div>
          )}
        </aside>

        <div className={css.main}>
          <div className={css.toolbar}>
            <SearchField
              value={query}
              onChange={value => { setQuery(value); setLimit(PAGE_SIZE) }}
              placeholder={t('knowledge.search')}
              hint={t('knowledge.searchHint')}
              label={t('knowledge.search')}
              clearLabel={t('common.clear')}
            />
            <span className={css.resultCount} aria-live="polite">
              {t('knowledge.loadedOf', { shown: shown.length, total: resources.length })}
            </span>
          </div>

          <div className={css.filterBar}>
            <FilterRow
              options={filters}
              value={collection}
              onChange={value => { setCollection(value); setLimit(PAGE_SIZE) }}
              label={t('knowledge.collections')}
              scroll
            />
          </div>

          <Panel padding="none" as="section" aria-labelledby="aria-knowledge-resources">
            <div className={css.panelHead}>
              <SectionHeading
                title={activeCollection === undefined ? t('knowledge.resources') : activeCollection.name}
                id="aria-knowledge-resources"
                hint={activeCollection === undefined ? t('knowledge.subtitle') : activeCollection.summary}
              />
            </div>

            {shown.length === 0 ? (
              <div className={css.stateWrap}>
                <RegionState
                  glyph="search"
                  title={t('knowledge.emptyTitle')}
                  description={t('knowledge.emptyBody')}
                  action={(
                    <Button size="sm" variant="outline" onClick={() => { setQuery(''); setCollection('all') }}>
                      {t('knowledge.clearSearch')}
                    </Button>
                  )}
                />
              </div>
            ) : (
              <ul className={css.resources}>
                {shown.map(resource => (
                  <ResourceRow key={resource.id} resource={resource} collection={workspace.collections.find(item => item.id === resource.collectionId)} now={now} t={t} />
                ))}
              </ul>
            )}

            {resources.length > shown.length ? (
              <div className={css.more}>
                <Button size="sm" variant="outline" onClick={() => { setLimit(current => current + PAGE_SIZE) }}>
                  {t('knowledge.loadMore')}
                </Button>
                <span className={css.moreCount}>{t('knowledge.loadedOf', { shown: shown.length, total: resources.length })}</span>
              </div>
            ) : null}
          </Panel>

          <PrototypeNotice text={t('app.prototypeNotice')} />
        </div>
      </div>
    </>
  )
}

/**
 * Render one resource row.
 * @param props.resource - the resource.
 * @param props.collection - its collection, for the classification label.
 * @param props.now - reference moment for the update age.
 * @param props.t - the dictionary resolver.
 * @returns the row.
 */
function ResourceRow({ resource, collection, now, t }: {
  resource: KnowledgeResource
  collection: KnowledgeCollection | undefined
  now: string
  t: Translate
}) {
  return (
    <li className={css.resource}>
      <span className={css.format} data-format={resource.format} aria-hidden="true">
        {resource.format.slice(0, 1).toUpperCase()}
      </span>
      <span className={css.resourceText}>
        <span className={css.resourceTitle}>{resource.title}</span>
        <span className={css.resourceMeta}>
          <span>{resource.source}</span>
          <span aria-hidden="true">·</span>
          <span>{t(`knowledge.format.${resource.format}`)}</span>
          <span aria-hidden="true">·</span>
          <span>{resource.size}</span>
          <span aria-hidden="true">·</span>
          <span>{t('knowledge.updated', { when: relativeAge(resource.updatedAt, now, t) })}</span>
        </span>
        <span className={css.tagRow}>
          {resource.tags.map(tag => <Tag key={tag} tone="muted">{tag}</Tag>)}
        </span>
      </span>
      <span className={css.resourceSide}>
        <span className={css.citations} title={t('knowledge.citations', { count: resource.citations })}>
          {resource.citations > 0 ? <GlyphArrowRight size={11} /> : null}
          {t('knowledge.citations', { count: resource.citations })}
        </span>
        <span className={css.classification}>{collection?.clearance ?? ''}</span>
      </span>
    </li>
  )
}
