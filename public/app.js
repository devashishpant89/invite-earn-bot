document.getElementById('fetchUserBtn').addEventListener('click', async () => {
  const userId = document.getElementById('userId').value.trim();
  if (!userId) {
    alert('Please enter a user ID.');
    return;
  }

  try {
    const response = await fetch(`/api/user/${userId}`);
    if (!response.ok) {
      if (response.status === 404) {
        alert('User not found.');
      } else {
        alert('Error fetching user data.');
      }
      return;
    }

    const data = await response.json();

    document.getElementById('statUserId').textContent = data.userId;
    document.getElementById('statInvites').textContent = data.invites;
    document.getElementById('statBonus').textContent = data.bonus.toFixed(2);
    document.getElementById('statEarnings').textContent = data.totalEarnings.toFixed(2);

    document.getElementById('user-stats').style.display = 'block';
  } catch (error) {
    alert('Failed to fetch user data.');
    console.error(error);
  }
});
