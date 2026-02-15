alert("JS Loaded");

let entries=JSON.parse(localStorage.getItem("entries"))||[];
let chart=null;

function showSection(id){
document.querySelectorAll("section").forEach(s=>s.style.display="none");
document.getElementById(id).style.display="block";

if(id==="dashboard") loadChart();
if(id==="history") loadHistory();
}

window.onload=()=>showSection("journal");

function saveEntry(){

let text=entry.value.trim();
let emotion=document.getElementById("emotion").value;

if(!text){
alert("Write something");
return;
}

entries.push({
text,
emotion,
date:new Date().toISOString().split("T")[0]
});

localStorage.setItem("entries",JSON.stringify(entries));

reflection.innerText=generateReflection(emotion);
entry.value="";
}

function generateReflection(e){
return{
Happy:"Keep smiling 🌟",
Sad:"You are strong 💙",
Stressed:"Breathe slowly",
Calm:"Stay peaceful 🌿",
Angry:"Relax your mind",
Anxious:"Everything will be okay"
}[e];
}

function autoDetectEmotion(){
let t=entry.value.toLowerCase();
if(t.includes("happy")) emotion.value="Happy";
else if(t.includes("sad")) emotion.value="Sad";
else if(t.includes("stress")) emotion.value="Stressed";
else if(t.includes("calm")) emotion.value="Calm";
else if(t.includes("angry")) emotion.value="Angry";
else if(t.includes("anxious")) emotion.value="Anxious";
else alert("Not detected");
}

function startVoice(){
let r=new(window.SpeechRecognition||webkitSpeechRecognition)();
r.start();
r.onresult=e=>entry.value=e.results[0][0].transcript;
}

function loadHistory(){
historyList.innerHTML="";
entries.slice().reverse().forEach(e=>{
historyList.innerHTML+=`<div class='card'>${e.date}<br>${e.text}<br>${e.emotion}</div>`;
});
}

function loadChart(){

let c={};
entries.forEach(e=>c[e.emotion]=(c[e.emotion]||0)+1);

if(chart) chart.destroy();

chart=new Chart(moodChart,{
type:"bar",
data:{
labels:Object.keys(c),
datasets:[{label:"Emotions",data:Object.values(c)}]
}
});

generateCalendar();
}

function generateCalendar(){
calendar.innerHTML="";
entries.forEach(e=>{
calendar.innerHTML+=`<div class='day'>${e.date.split("-")[2]}</div>`;
});
}

function exportData(){
let a=document.createElement("a");
a.href="data:text/json;charset=utf-8,"+encodeURIComponent(JSON.stringify(entries));
a.download="musemind.json";
a.click();
}
