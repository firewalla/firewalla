const maxWidthCount = 300
const labels = Array.from({ length: maxWidthCount }, (_, i) => i)

const chartOptions = {
    plugins: {
        legend: {
            display: false,
        }
    },
    elements: {
        point: {
            radius: 0
        }
    },
    scales: {
        x: {
            grid: {
                display: false,
            },
            ticks: {
                display: false,
            },
        },
        y: {
            grid: {
                display: false
            },
            ticks: {
                display: false,
            },
            max: 1,
            min: 0
        },
    }
}

function addDataToChart(chart, data, color) {
    if (chart.data.datasets[0].data.length === maxWidthCount) {
        chart.data.datasets[0].data = chart.data.datasets[0].data.slice(1, maxWidthCount)
        chart.data.datasets[0].backgroundColor = chart.data.datasets[0].backgroundColor.slice(1, maxWidthCount)
    }
    chart.data.datasets[0].data.push(data)
    chart.data.datasets[0].backgroundColor.push(color)

    chart.update();
}

function append_data(canvas_id, value, color, id) {
    addDataToChart(canvas_id, value, color)
}
  // append_data(stackedLine1, 7, 'rgb(0, 0, 0)') call function like this
