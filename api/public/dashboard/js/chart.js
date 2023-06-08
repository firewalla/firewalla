const maxWidthCount = 300
const vipMaxWidthCount = 720
const labels = Array.from({ length: maxWidthCount }, (_, i) => i)
const vipLabels = Array.from({ length: vipMaxWidthCount }, (_, i) => i)

const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
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
    },
    aspectRatio: 8,
    animation: {
        duration: 0
    }
}

const vipChartOptions = JSON.parse(JSON.stringify(chartOptions));
vipChartOptions.aspectRatio = 24;

function addDataToChart(chart, data, color) {
    if (chart.data.datasets[0].data.length === maxWidthCount) {
        chart.data.datasets[0].data = chart.data.datasets[0].data.slice(1, maxWidthCount)
        chart.data.datasets[0].backgroundColor = chart.data.datasets[0].backgroundColor.slice(1, maxWidthCount)
    }
    chart.data.datasets[0].data.push(data)
    chart.data.datasets[0].backgroundColor.push(color)

    chart.update();
}

function addDataToVIPChart(chart, data, color) {
    if (chart.data.datasets[0].data.length === vipMaxWidthCount) {
        chart.data.datasets[0].data = chart.data.datasets[0].data.slice(1, vipMaxWidthCount)
        chart.data.datasets[0].backgroundColor = chart.data.datasets[0].backgroundColor.slice(1, vipMaxWidthCount)
    }
    chart.data.datasets[0].data.push(data)
    chart.data.datasets[0].backgroundColor.push(color)
}

function append_data(canvas_id, value, color, id) {
    addDataToChart(canvas_id, value, color)
}
  // append_data(stackedLine1, 7, 'rgb(0, 0, 0)') call function like this
