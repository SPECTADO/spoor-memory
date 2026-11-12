import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LineChart, linePath, niceMax, StackedBarChart } from './Charts'

describe('niceMax', () => {
  it('rounds up to 1, 2 or 5 × 10ⁿ, and 1 for nothing', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(7)).toBe(10)
    expect(niceMax(13)).toBe(20)
    expect(niceMax(41)).toBe(50)
    expect(niceMax(100)).toBe(100)
    expect(niceMax(101)).toBe(200)
  })
})

describe('linePath', () => {
  it('draws runs of points and breaks the line at gaps', () => {
    expect(linePath([0, 10], 0, 10)).toBe('M0.00 39.00 L100.00 1.00')
    const gap = linePath([1, null, 1, 1, null], 0, 2)
    expect(gap.match(/M/g)).toHaveLength(2)
  })

  it('turns a lone point into a dot and nothing into an empty path', () => {
    expect(linePath([null, 5, null], 0, 10)).toBe('M50.00 20.00 L50.00 20.00')
    expect(linePath([null, null], 0, 1)).toBe('')
    expect(linePath([], 0, 1)).toBe('')
  })
})

describe('StackedBarChart', () => {
  it('is an image with a title and description, a legend, and a hidden table of every number', () => {
    render(
      <StackedBarChart
        title="Requests per day"
        description="Reads and writes."
        series={[
          { name: 'reads', fill: 'fill-accent', swatch: 'bg-accent' },
          { name: 'writes', fill: 'fill-warning', swatch: 'bg-warning' },
        ]}
        data={[
          { label: 'Nov 1', values: [3, 1] },
          { label: 'Nov 2', values: [0, 0] },
          { label: 'Nov 3', values: [12, 5] },
        ]}
      />,
    )
    const img = screen.getByRole('img', { name: /Requests per day Reads and writes\./ })
    expect(img.querySelectorAll('rect')).toHaveLength(4) // empty segments draw nothing
    expect(screen.getByText('20')).toBeInTheDocument() // the axis top
    expect(screen.getAllByText('reads')).toHaveLength(2) // legend and table header
    const table = screen.getByRole('table', { name: 'Requests per day' })
    const row = within(table).getByRole('row', { name: /Nov 3/ })
    expect(row).toHaveTextContent('Nov 3125')
  })
})

describe('LineChart', () => {
  it('says its numbers in the description and draws one path', () => {
    render(<LineChart title="CPU" description="now 4 %, lowest 1 %, highest 9 %." values={[1, null, 9, 4]} />)
    const img = screen.getByRole('img', { name: 'CPU now 4 %, lowest 1 %, highest 9 %.' })
    expect(img.querySelectorAll('path')).toHaveLength(1)
  })

  it('draws only the baseline without values', () => {
    render(<LineChart title="Empty" description="no samples" values={[null, null]} />)
    expect(screen.getByRole('img', { name: 'Empty no samples' }).querySelector('path')).toBeNull()
  })
})
