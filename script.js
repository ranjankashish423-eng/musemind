let history = [];

// LOGIN
function login() {
    let name = document.getElementById("name").value;
    let age = document.getElementById("age").value;
    let gender = document.getElementById("gender").value;

    if (name === "" || age === "" || gender === "") {
        alert("Please fill all details");
        return;
    }

    let user = { name, age, gender };
    localStorage.setItem("user", JSON.stringify(user));

    showApp(user);
}

// SHOW APP
function showApp(user) {
    document.getElementById("loginBox").style.display = "none";
    document.getElementById("app").style.display = "block";

    document.getElementById("welcome").innerText =
        `Welcome ${user.name} (${user.gender}, ${user.age})`;
}

// LOAD DATA
window.onload = function () {
    let savedUser = localStorage.getItem("user");
    if (savedUser) showApp(JSON.parse(savedUser));

    let savedHistory = localStorage.getItem("history");
    if (savedHistory) {
        history = JSON.parse(savedHistory);
        updateDashboard();
        displayHistory();
    }
};

// LOGOUT
function logout() {
    localStorage.clear();
    location.reload();
}

// EMOTION ANALYSIS
function analyzeEmotion() {

    let text = document.getElementById("entry").value.toLowerCase();

    if (text === "") {
        alert("Write something first");
        return;
    }

    let scores = { Happy: 0, Sad: 0, Stressed: 0, Calm: 0 };

    let happy = ["happy","khush","good","😊"];
    let sad = ["sad","dukhi","😢"];
    let stress = ["stress","tension","exam","😡"];
    let calm = ["calm","relax","peace"];

    happy.forEach(w => { if (text.includes(w)) scores.Happy++; });
    sad.forEach(w => { if (text.includes(w)) scores.Sad++; });
    stress.forEach(w => { if (text.includes(w)) scores.Stressed++; });
    calm.forEach(w => { if (text.includes(w)) scores.Calm++; });

    if (Object.values(scores).every(v => v === 0)) scores.Calm = 1;

    let sorted = Object.entries(scores).sort((a,b)=>b[1]-a[1]);

    let primary = sorted[0][0];

    document.getElementById("result").innerHTML =
        `Emotion: ${primary}`;

    // SAVE FULL ENTRY
    let entryObj = {
        text: text,
        emotion: primary
    };

    history.push(entryObj);
    localStorage.setItem("history", JSON.stringify(history));

    displayHistory();
    updateDashboard();

    document.getElementById("entry").value = "";
}

// DISPLAY HISTORY
function displayHistory() {
    let box = document.getElementById("historyBox");
    box.innerHTML = "";

    history.slice().reverse().forEach(entry => {
        box.innerHTML += `
            <p>• ${entry.text} → <b>${entry.emotion}</b></p>
        `;
    });
}

// DASHBOARD
function updateDashboard() {

    let counts = { Happy: 0, Sad: 0, Stressed: 0, Calm: 0 };

    history.forEach(e => counts[e.emotion]++);

    document.getElementById("dashboard").innerHTML = `
        <p>Happy: ${counts.Happy}</p>
        <p>Sad: ${counts.Sad}</p>
        <p>Stressed: ${counts.Stressed}</p>
        <p>Calm: ${counts.Calm}</p>
    `;

    updateChart(counts);
}

// CHART
let chart;

function updateChart(counts) {
    let ctx = document.getElementById("chart");

    if (chart) chart.destroy();

    chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ["Happy","Sad","Stressed","Calm"],
            datasets: [{
                data: [counts.Happy,counts.Sad,counts.Stressed,counts.Calm],
                backgroundColor: ["green","red","orange","blue"]
            }]
        },
        options: { plugins:{legend:{display:false}} }
    });
}
